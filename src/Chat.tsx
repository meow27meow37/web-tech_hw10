import { useEffect, useRef, useState } from 'react'
import { АДРЕС_ЧАТА, взятьПропуск } from './api'

// ПРОТОКОЛ ЧАТА (разобран живыми запросами к серверу преподавателя):
//
//   мы  → { "type": "AUTH",         "payload": { "token": "<access>" } }
//   нам ← { "type": "AUTH_SUCCESS", "payload": { "username": "..." } }
//   мы  → { "type": "CHAT_MESSAGE", "payload": { "text": "..." } }
//   нам ← { "type": "NEW_MESSAGE",  "payload": { sender, text, timestamp } }
//
// Важное, что видно только на опытах:
//  • Пока не прислал AUTH — писать нельзя: сервер рвёт связь с кодом 4003
//    Unauthorized. Это и есть требование «пишут только авторизованные», и
//    держится оно на сервере, а не на том, что мы спрятали поле ввода.
//  • Кривой пропуск — тоже разрыв 4003, но с пояснением Invalid Token.
//  • Своё же сообщение приходит обратно вместе со всеми, поэтому в ленту
//    руками ничего не дописываем: иначе каждое своё будет двоиться.
//  • Истории сервер не присылает: видно только то, что пришло при тебе.
//  • Пустой текст сервер молча глотает — не отправляем его сами.

export interface Сообщение {
  sender: string
  text: string
  timestamp: number
}

type Состояние = 'подключаемся' | 'на связи' | 'оборвалась'

interface Свойства {
  ник: string
}

export default function Чат({ ник }: Свойства) {
  const [сообщения, установитьСообщения] = useState<Сообщение[]>([])
  const [состояние, установитьСостояние] = useState<Состояние>('подключаемся')
  const [причина, установитьПричину] = useState<string | null>(null)
  const [текст, установитьТекст] = useState('')
  // Меняем число — и useEffect ниже запускается заново, то есть переподключаемся.
  const [попытка, установитьПопытку] = useState(0)

  const сокет = useRef<WebSocket | null>(null)
  const лента = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // StrictMode в режиме разработки запускает эффект дважды, да и уйти со
    // страницы можно в любой момент. Флаг «ушли» спасает от двух бед: лишнего
    // открытого сокета и записи в состояние уже размонтированного компонента.
    let ушли = false
    let связь: WebSocket | null = null

    const подключиться = async () => {
      установитьСостояние('подключаемся')
      установитьПричину(null)
      try {
        // Пропуск берём ПЕРЕД открытием сокета: если он протух, его сначала
        // продлят по куке. Открывать сокет с мёртвым токеном бессмысленно —
        // сервер всё равно оборвёт связь.
        const пропуск = await взятьПропуск()
        if (ушли) return

        связь = new WebSocket(АДРЕС_ЧАТА)
        сокет.current = связь

        связь.onopen = () => {
          связь?.send(JSON.stringify({ type: 'AUTH', payload: { token: пропуск } }))
        }

        связь.onmessage = (событие) => {
          if (ушли) return
          let письмо: { type?: string; payload?: Record<string, unknown> }
          try {
            письмо = JSON.parse(String(событие.data))
          } catch {
            return // мусор вместо JSON просто пропускаем, связь рвать незачем
          }

          if (письмо.type === 'AUTH_SUCCESS') {
            установитьСостояние('на связи')
            return
          }

          if (письмо.type === 'NEW_MESSAGE' && письмо.payload) {
            const п = письмо.payload
            установитьСообщения((прежние) => [
              ...прежние,
              {
                sender: String(п.sender ?? 'кто-то'),
                text: String(п.text ?? ''),
                timestamp: Number(п.timestamp ?? Date.now()),
              },
            ])
          }
        }

        связь.onclose = (событие) => {
          if (ушли) return
          установитьСостояние('оборвалась')
          установитьПричину(пояснение(событие.code, событие.reason))
        }
      } catch {
        if (ушли) return
        установитьСостояние('оборвалась')
        установитьПричину('Не удалось получить пропуск — похоже, пора войти заново.')
      }
    }

    подключиться()

    return () => {
      ушли = true
      сокет.current = null
      связь?.close()
    }
  }, [попытка])

  // Лента всегда прокручена к свежему сообщению, иначе новое приходит «ниже
  // экрана» и кажется, что чат не работает.
  useEffect(() => {
    const узел = лента.current
    if (узел) узел.scrollTop = узел.scrollHeight
  }, [сообщения])

  const отправить = (событие: React.FormEvent) => {
    событие.preventDefault()
    const чистый = текст.trim()
    if (!чистый || состояние !== 'на связи') return
    сокет.current?.send(JSON.stringify({ type: 'CHAT_MESSAGE', payload: { text: чистый } }))
    установитьТекст('')
  }

  return (
    <div className="карточка чат">
      <div className="шапка-чата">
        <h2>Общий чат</h2>
        <span className={`связь ${классСвязи(состояние)}`}>{подписьСвязи(состояние)}</span>
      </div>

      {причина && <p className="ошибка">{причина}</p>}

      <div className="лента" ref={лента}>
        {сообщения.length === 0 ? (
          <p className="пусто-в-ленте">
            Пока тихо. Сервер не хранит историю — видно только то, что придёт
            при вас. Напишите первым или откройте чат во второй вкладке.
          </p>
        ) : (
          сообщения.map((с, номер) => (
            <div
              key={`${с.timestamp}-${номер}`}
              className={с.sender === ник ? 'сообщение моё' : 'сообщение'}
            >
              <div className="кто-и-когда">
                <span className="автор">{с.sender === ник ? 'Вы' : с.sender}</span>
                <span className="время">{время(с.timestamp)}</span>
              </div>
              <div className="текст">{с.text}</div>
            </div>
          ))
        )}
      </div>

      {состояние === 'оборвалась' ? (
        <button
          type="button"
          className="главная"
          onClick={() => установитьПопытку((н) => н + 1)}
        >
          Подключиться заново
        </button>
      ) : (
        <form className="ряд" onSubmit={отправить}>
          <input
            className="поле-сообщения"
            value={текст}
            onChange={(с) => установитьТекст(с.target.value)}
            placeholder={состояние === 'на связи' ? 'Сообщение…' : 'Подключаемся…'}
            disabled={состояние !== 'на связи'}
            maxLength={500}
            aria-label="Сообщение"
          />
          <button
            type="submit"
            className="главная"
            disabled={состояние !== 'на связи' || текст.trim() === ''}
          >
            Отправить
          </button>
        </form>
      )}
    </div>
  )
}

function время(метка: number): string {
  return new Date(метка).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function подписьСвязи(состояние: Состояние): string {
  if (состояние === 'на связи') return 'на связи'
  if (состояние === 'подключаемся') return 'подключаемся…'
  return 'связь оборвалась'
}

function классСвязи(состояние: Состояние): string {
  if (состояние === 'на связи') return 'есть'
  if (состояние === 'подключаемся') return 'ждём'
  return 'нет'
}

/** Сервер закрывает связь своими кодами — переводим их на человеческий. */
function пояснение(код: number, текст: string): string {
  if (код === 4003 && текст === 'Invalid Token') {
    return 'Сервер не принял пропуск. Войдите заново.'
  }
  if (код === 4003) {
    return 'Сервер не узнал вас и закрыл связь. Войдите заново.'
  }
  if (код === 1000) return 'Связь закрыта.'
  return `Связь оборвалась (код ${код}${текст ? `, ${текст}` : ''}).`
}
