import { send } from '../client.js'
import {
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
} from '../vue.js'

const HOLD_MS = 600

export const HoldSend = defineComponent({
  props: { chat: Object, modelValue: String, quote: Object },
  emits: ['update:modelValue', 'sent', 'clear-quote'],
  setup(props, { emit, expose }) {
    const holding = ref(false)
    const sending = ref(false)
    const error = ref('')
    const textarea = ref(null)
    expose({ focus: () => textarea.value?.focus(), insertMention })
    let timer
    let gesture

    function cancel() {
      clearTimeout(timer)
      gesture = undefined
      holding.value = false
    }

    function insertMention(userId) {
      const field = textarea.value
      if (!field) return
      const xml = userId.replace(
        /[&"<>]/g,
        (character) =>
          ({
            '&': '&amp;',
            '"': '&quot;',
            '<': '&lt;',
            '>': '&gt;',
          })[character]
      )
      const token = `<at id="${xml}"/> `
      const { selectionStart, selectionEnd } = field
      const value =
        props.modelValue.slice(0, selectionStart) +
        token +
        props.modelValue.slice(selectionEnd)
      cancel()
      if (value.length > 2000) {
        error.value = '插入艾特后超过 2000 个字符。'
        return
      }
      error.value = ''
      emit('update:modelValue', value)
      void nextTick(() => {
        field.focus()
        const cursor = selectionStart + token.length
        field.setSelectionRange(cursor, cursor)
      })
    }

    async function submit(text, quoteId) {
      const { platform, selfId, channelId } = props.chat
      sending.value = true
      error.value = ''
      try {
        await send('qqbot-admin/chat-send', {
          platform,
          selfId,
          channelId,
          text,
          quoteId,
        })
        if (props.modelValue.trim() === text && props.quote?.id === quoteId) {
          emit('update:modelValue', '')
          emit('clear-quote')
        }
        emit('sent')
      } catch (cause) {
        error.value = String(cause?.message ?? cause)
      } finally {
        sending.value = false
      }
    }

    function start(input) {
      const text = props.modelValue.trim()
      const quoteId = props.quote?.id
      if (gesture || sending.value || !text || props.quote?.recalled) return
      gesture = input
      holding.value = true
      timer = setTimeout(() => {
        cancel()
        if (
          props.modelValue.trim() === text &&
          props.quote?.id === quoteId &&
          !props.quote?.recalled &&
          document.hasFocus()
        )
          void submit(text, quoteId)
      }, HOLD_MS)
    }

    function keyDown(event) {
      if (event.key === 'Escape') return cancel()
      if (
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.keyCode === 229
      )
        return
      event.preventDefault()
      if (!event.repeat) start({ key: event.key })
    }

    function keyUp(event) {
      if (event.key === gesture?.key) cancel()
    }

    function endPointer(event) {
      if (event.pointerId === gesture?.pointerId) cancel()
    }

    function movePointer(event) {
      if (event.pointerId !== gesture?.pointerId) return
      const area = event.currentTarget.getBoundingClientRect()
      if (
        event.clientX < area.left ||
        event.clientX > area.right ||
        event.clientY < area.top ||
        event.clientY > area.bottom
      )
        cancel()
    }

    function visibility() {
      if (document.hidden) cancel()
    }

    onMounted(() => {
      window.addEventListener('blur', cancel)
      window.addEventListener('keyup', keyUp)
      document.addEventListener('visibilitychange', visibility)
    })
    onUnmounted(() => {
      cancel()
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keyup', keyUp)
      document.removeEventListener('visibilitychange', visibility)
    })

    return () =>
      h(
        'div',
        {
          class: 'qc-composer',
          onFocusout: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) cancel()
          },
        },
        [
          props.quote
            ? h('div', { class: 'qc-reply-draft' }, [
                h('div', [
                  h(
                    'strong',
                    props.quote.recalled
                      ? '引用已撤回或删除'
                      : `引用 ${props.quote.author}`
                  ),
                  h(
                    'span',
                    props.quote.recalled
                      ? '请取消引用或选择另一条消息'
                      : props.quote.preview
                  ),
                ]),
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-label': '取消引用',
                    onClick: () => {
                      cancel()
                      emit('clear-quote')
                    },
                  },
                  '×'
                ),
              ])
            : null,
          h('div', { class: 'qc-compose-row' }, [
            h('textarea', {
              ref: textarea,
              'aria-label': '给当前会话发送消息',
              'aria-describedby': 'qc-send-hint',
              placeholder: '以本机器人身份发送消息',
              value: props.modelValue,
              maxlength: 2000,
              rows: 2,
              onInput: (event) => {
                cancel()
                emit('update:modelValue', event.target.value)
              },
              onKeydown: keyDown,
            }),
            h(
              'button',
              {
                type: 'button',
                class: ['qc-send', holding.value && 'is-holding'],
                disabled:
                  sending.value ||
                  !props.modelValue.trim() ||
                  props.quote?.recalled,
                'aria-describedby': 'qc-send-hint',
                onContextmenu: (event) => event.preventDefault(),
                onPointerdown: (event) => {
                  if (event.button !== 0 || !event.isPrimary) return
                  event.currentTarget.setPointerCapture(event.pointerId)
                  start({ pointerId: event.pointerId })
                },
                onPointermove: movePointer,
                onPointerup: endPointer,
                onPointercancel: endPointer,
                onLostpointercapture: endPointer,
                onKeydown: keyDown,
              },
              h('span', sending.value ? '发送中…' : '按住发送')
            ),
          ]),
          h(
            'div',
            { id: 'qc-send-hint', class: 'qc-compose-hint' },
            '按住按钮或回车 0.6 秒发送 · Shift + Enter 换行'
          ),
          error.value
            ? h('p', { role: 'alert', class: 'qc-error' }, error.value)
            : null,
        ]
      )
  },
})
