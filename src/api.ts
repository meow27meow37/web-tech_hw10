// Всё общение с сервером собрано здесь: и обычные запросы, и выдача пропуска
// для вебсокета.
//
// АВТОРИЗАЦИЯ НА ДВУХ ТОКЕНАХ (JWT):
//
//   access  — короткий пропуск, живёт ВСЕГО 5 МИНУТ. Лежит только в памяти
//             вкладки (переменная ниже). В localStorage его не кладут: туда
//             может залезть любой чужой скрипт на странице.
//   refresh — долгий, на 7 дней. Нам его не показывают: сервер кладёт его в
//             куку refresh_token с пометкой HttpOnly, из JavaScript она не
//             читается. Браузер подставляет её сам, но только если разрешить
//             отправку кук — отсюда credentials: 'include' в КАЖДОМ запросе.
//
// Пять минут — это мало, поэтому обновление встроено В САМ ЗАПРОС, а не
// повешено на кнопку: получили 401 — сходили за новым пропуском и повторили
// запрос ОДИН раз.
//
// У куки refresh_token путь Path=/api/, а чат живёт по адресу /chat/ —
// значит до вебсокета кука НЕ доходит. Поэтому чат и просит пропуск первым
// сообщением: другого способа представиться у него нет.

export const БАЗА = 'https://inai-col3.fishrungames.com'
export const АДРЕС_ЧАТА = 'wss://inai-col3.fishrungames.com/chat/'

let пропуск: string | null = null

// ВЫХОД ПРИХОДИТСЯ ДЕРЖАТЬ САМИМ. Проверено опытом:
//   • /api/logout/ отвечает «Успешный выход», но куку НЕ стирает — в своём
//     заголовке удаления сервер забыл Secure и SameSite=None, а раз кука
//     ставилась с ними, браузер такое удаление отвергает (сайт и сервер на
//     разных доменах);
//   • старый refresh после выхода по-прежнему выдаёт новые пропуски, то есть
//     сервер его и не отзывает.
// Итог: после «Выйти» и перезагрузки страницы человек снова оказался бы внутри
// чата. Поэтому ставим свою метку: она переживает перезагрузку и запрещает
// восстанавливать сессию, пока не войдут заново.
const МЕТКА_ВЫХОДА = 'gruppovoy-chat:вышли'

function пометитьВыход(вышли: boolean): void {
  // В приватном окне localStorage может быть запрещён — тогда просто живём
  // без метки, падать из-за этого приложению незачем.
  try {
    if (вышли) localStorage.setItem(МЕТКА_ВЫХОДА, '1')
    else localStorage.removeItem(МЕТКА_ВЫХОДА)
  } catch {
    /* обойдёмся */
  }
}

export function выходилиРаньше(): boolean {
  try {
    return localStorage.getItem(МЕТКА_ВЫХОДА) === '1'
  } catch {
    return false
  }
}

export interface Профиль {
  first_name: string
  specialization: string
  specialization_display: string
  bio: string
  fee: string
}

export interface Пользователь {
  id: number
  username: string
  profile: Профиль
}

interface ОтветСВходом {
  access: string
  user: Пользователь
}

/** Ошибка сервера с уже разобранным человеческим текстом. */
export class ОшибкаСервера extends Error {
  код: number
  constructor(код: number, текст: string) {
    super(текст)
    this.код = код
    this.name = 'ОшибкаСервера'
  }
}

/** Тело ответа может оказаться и не JSON (см. разбор ошибок ниже), поэтому
 *  JSON.parse обёрнут: иначе одна кривая страница валит всё приложение. */
function разобрать(текст: string): unknown {
  if (!текст) return null
  try {
    return JSON.parse(текст)
  } catch {
    return null
  }
}

// Сервер отвечает об ошибках в ТРЁХ формах, и все три надо уметь читать:
//   { "detail": "Неверный логин или пароль." }         — 401
//   { "password": ["Убедитесь, что это значение…"] }   — 400
//   HTML-страница «Server Error (500)» без JSON         — 500
function текстОшибки(код: number, тело: unknown, путь: string): string {
  if (тело === null) {
    // Занятый логин у этого сервера падает в 500 и отдаёт HTML вместо JSON.
    // Это ошибка на стороне сервера, но сказать надо по-человечески.
    if (код === 500 && путь === '/api/register/') {
      return 'Такой логин уже занят — придумайте другой.'
    }
    return `Сервер ответил ошибкой ${код}`
  }
  if (typeof тело !== 'object') return `Сервер ответил ошибкой ${код}`

  const данные = тело as Record<string, unknown>
  if (typeof данные.detail === 'string') return данные.detail

  const куски: string[] = []
  for (const [поле, значение] of Object.entries(данные)) {
    if (поле === 'code' || поле === 'messages') continue
    const строки = Array.isArray(значение) ? значение : [значение]
    куски.push(`${подпись(поле)}: ${строки.join(' ')}`)
  }
  return куски.length ? куски.join('\n') : `Сервер ответил ошибкой ${код}`
}

function подпись(поле: string): string {
  const словарь: Record<string, string> = {
    username: 'Логин',
    password: 'Пароль',
  }
  return словарь[поле] ?? поле
}

async function сходить(путь: string, настройки: RequestInit): Promise<Response> {
  return fetch(`${БАЗА}${путь}`, {
    ...настройки,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      // Заголовок добавляем ТОЛЬКО когда пропуск есть: пустой «Bearer null»
      // сервер считает кривым токеном и отвечает иначе, чем на отсутствие.
      ...(пропуск ? { Authorization: `Bearer ${пропуск}` } : {}),
      ...(настройки.headers ?? {}),
    },
  })
}

/** Новый пропуск по куке refresh_token. Тело не нужно — сервер берёт всё из
 *  куки. Нет куки или протухла — бросаем ошибку. */
async function обновитьПропуск(): Promise<void> {
  // Вышли — значит вышли: чужая кука ещё жива и сервер охотно выдал бы новый
  // пропуск, но мы этого не хотим.
  if (выходилиРаньше()) {
    пропуск = null
    throw new ОшибкаСервера(401, 'Вы вышли из аккаунта')
  }
  const ответ = await fetch(`${БАЗА}/api/token/refresh/`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  })
  const тело = разобрать(await ответ.text()) as { access?: string } | null
  if (!ответ.ok || !тело?.access) {
    пропуск = null
    throw new ОшибкаСервера(ответ.status, 'Сессия истекла, войдите заново')
  }
  пропуск = тело.access
}

/**
 * Запрос с автоматическим продлением пропуска: получили 401 — молча взяли
 * новый по куке и повторили ОДИН раз. Больше одного нельзя, иначе при
 * настоящей просрочке refresh-куки вышел бы вечный круг.
 */
async function запрос<T>(
  путь: string,
  настройки: RequestInit = {},
  продлевать = true,
): Promise<T> {
  let ответ = await сходить(путь, настройки)

  if (ответ.status === 401 && продлевать) {
    await обновитьПропуск()
    ответ = await сходить(путь, настройки)
  }

  const тело = разобрать(await ответ.text())
  if (!ответ.ok) throw new ОшибкаСервера(ответ.status, текстОшибки(ответ.status, тело, путь))
  return тело as T
}

/** Пропуск для вебсокета. Если в памяти пусто (например, после перезагрузки
 *  страницы) — сначала продлеваем по куке. */
export async function взятьПропуск(): Promise<string> {
  if (!пропуск) await обновитьПропуск()
  return пропуск as string
}

// продлевать = false: на 401 «неверный логин или пароль» продлевать нечего,
// иначе человек увидит «сессия истекла» вместо настоящей причины.
export async function зарегистрироваться(логин: string, пароль: string) {
  const ответ = await запрос<ОтветСВходом>(
    '/api/register/',
    { method: 'POST', body: JSON.stringify({ username: логин, password: пароль }) },
    false,
  )
  пропуск = ответ.access
  пометитьВыход(false)
  return ответ.user
}

export async function войти(логин: string, пароль: string) {
  const ответ = await запрос<ОтветСВходом>(
    '/api/login/',
    { method: 'POST', body: JSON.stringify({ username: логин, password: пароль }) },
    false,
  )
  пропуск = ответ.access
  пометитьВыход(false)
  return ответ.user
}

/** Выход. Сервер о нём честно сообщает, но ни куку не стирает, ни refresh не
 *  отзывает (см. комментарий к метке выше), поэтому настоящий выход — это
 *  наши две строки: стереть пропуск из памяти и поставить метку. */
export async function выйти() {
  try {
    return await запрос<{ detail: string }>('/api/logout/', { method: 'POST' }, false)
  } finally {
    пропуск = null
    пометитьВыход(true)
  }
}

export function мойПрофиль() {
  return запрос<Пользователь>('/api/profile/')
}

/** Запуск приложения: пробуем понять, вошли мы или нет.
 *  Вышли в прошлый раз — даже не спрашиваем сервер. */
export async function восстановитьСессию(): Promise<Пользователь | null> {
  if (выходилиРаньше()) return null
  try {
    return await мойПрофиль()
  } catch {
    return null
  }
}
