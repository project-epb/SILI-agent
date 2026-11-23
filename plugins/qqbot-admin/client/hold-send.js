import { send } from '../client.js'
import { defineComponent, h, onMounted, onUnmounted, ref } from '../vue.js'

const HOLD_MS = 600

export const HoldSend = defineComponent({
  props: { chat: Object, modelValue: String },
  emits: ['update:modelValue', 'sent'],
  setup(props, { emit }) {
    const holding = ref(false)
    const sending = ref(false)
    const error = ref('')
    let timer
    let gesture

    function cancel() {
      clearTimeout(timer)
      gesture = undefined
      holding.value = false
    }

    async function submit(text) {
      const { selfId, channelId } = props.chat
      sending.value = true
      error.value = ''
      try {
        await send('qqbot-admin/chat-send', { selfId, channelId, text })
        if (props.modelValue.trim() === text) emit('update:modelValue', '')
        emit('sent')
      } catch (cause) {
        error.value = String(cause?.message ?? cause)
      } finally {
        sending.value = false
      }
    }

    function start(input) {
      const text = props.modelValue.trim()
      if (gesture || sending.value || !text) return
      gesture = input
      holding.value = true
      timer = setTimeout(() => {
        cancel()
        if (props.modelValue.trim() === text && document.hasFocus())
          void submit(text)
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
          h('div', { class: 'qc-compose-row' }, [
            h('textarea', {
              'aria-label': '给当前会话发送消息',
              'aria-describedby': 'qc-send-hint',
              placeholder: '以 SILI 身份发送消息',
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
                disabled: sending.value || !props.modelValue.trim(),
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
