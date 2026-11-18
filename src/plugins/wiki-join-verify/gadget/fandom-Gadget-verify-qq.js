/**
 * @name Verify-QQ-number
 * @desc Generates a one-time code for joining the Fandom QQ group: saves
 *       `<timestamp>#<sha1(timestamp#code)>` to User:<name>/qq-hash and shows
 *       the join answer `<user id>-<code>`. SILI checks the answer against the
 *       page; sysops can check it here by hand when SILI is down.
 *       Deployed by hand to MediaWiki:Gadget-verify-qq.js on
 *       community.fandom.com/zh. Must match src/plugins/wiki-join-verify.
 * @author 机智的小鱼君
 */

// ES3 syntax only (Fandom gadget requirement): var, function, no arrows,
// no template literals.

$(function () {
  // Config
  var QQ_HASH_SUFFIX = '/qq-hash', // user subpage that stores the hash
    ADMIN_GROUP = 'sysop', // user group allowed to check other users
    // Crockford base32 (no I, L, O, U); 32 divides 256, so byte % 32 is unbiased
    CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
    CODE_LENGTH = 16,
    ANSWER_PATTERN = /(\d{1,12})\s*-\s*([0-9A-Za-z]{16})/,
    CODE_TTL_MS = 2 * 60 * 60 * 1000,
    CODE_TTL_LABEL = '2 小时',
    // Each code is an edit and replaces the one just shown: slow down regeneration.
    REGENERATE_COOLDOWN_S = 10,
    NOTICE_HTML =
      '这是你的<b>一次性</b>加群码，<b><i>请勿分享给其他人</i></b>。<br>' +
      '请在2小时内使用，将其完整粘贴到加群答案中即可。<br>' +
      '如有遗失，可回到这里重新生成（旧码作废）。'

  // Variables
  var config = mw.config.get(),
    pageName = config.wgPageName.replace(/\s+/g, '_'),
    userName = (config.wgUserName || '').replace(/\s+/g, '_'),
    userId = config.wgUserId,
    isAdmin = (config.wgUserGroups || []).indexOf(ADMIN_GROUP) !== -1,
    mwApi = new mw.Api({ parameters: { format: 'json', formatversion: 2 } }),
    verifyPage = 'User:' + userName + QQ_HASH_SUFFIX,
    appRoot = document.getElementById('VERIFY_QQ_APP')

  // Utils
  function SHA1(str) {
    return crypto.subtle
      .digest('SHA-1', new TextEncoder('utf-8').encode('' + str))
      .then(function (buf) {
        return Array.prototype.map
          .call(new Uint8Array(buf), function (x) {
            return ('00' + x.toString(16)).slice(-2)
          })
          .join('')
      })
  }
  function sameUser(a, b) {
    return ('' + a).replace(/[\s_]+/g, '_') === ('' + b).replace(/[\s_]+/g, '_')
  }
  function randomCode() {
    var bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH)),
      code = ''
    for (var i = 0; i < bytes.length; i++) {
      code += CODE_ALPHABET.charAt(bytes[i] % 32)
    }
    return code
  }
  function parseAnswer(str) {
    var match = ANSWER_PATTERN.exec('' + str)
    if (!match) return null
    var code = match[2].toUpperCase()
    for (var i = 0; i < code.length; i++) {
      if (CODE_ALPHABET.indexOf(code.charAt(i)) === -1) return null
    }
    return { userId: match[1], code: code }
  }
  function copyText(text, $fallback) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
    }
    var range = document.createRange()
    range.selectNodeContents($fallback.get(0))
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
    document.execCommand('copy')
    return Promise.resolve()
  }

  // API
  function saveCode() {
    var code = randomCode(),
      now = Date.now()
    return SHA1(now + '#' + code).then(function (hash) {
      return mwApi
        .postWithEditToken({
          action: 'edit',
          title: verifyPage,
          text: now + '#' + hash,
          summary: '生成入群验证码',
        })
        .then(function () {
          return userId + '-' + code
        })
    })
  }
  function userNameById(id) {
    return mwApi
      .get({ action: 'query', list: 'users', ususerids: id })
      .then(function (data) {
        var user = data.query.users[0]
        return user && !user.missing ? user.name : null
      })
  }
  function readRecord(name) {
    return mwApi
      .get({
        action: 'query',
        prop: 'revisions',
        rvprop: 'user|content',
        rvslots: 'main',
        titles: 'User:' + name + QQ_HASH_SUFFIX,
      })
      .then(function (data) {
        var page = data.query.pages[0],
          rev = page && page.revisions && page.revisions[0]
        if (!rev) return null
        return { editor: rev.user, content: rev.slots.main.content }
      })
  }

  /**
   * Same checks as SILI except "already used", which only SILI records.
   * expectedName: the page owner when checking on their qq-hash page.
   * Resolves { ok: boolean, text: string }.
   */
  function checkAnswer(answer, expectedName) {
    var parsed = parseAnswer(answer)
    if (!parsed) return Promise.resolve({ ok: false, text: '答案格式不对' })
    var name
    return userNameById(parsed.userId).then(function (found) {
      name = found
      if (!name) return { ok: false, text: '答案里的 Fandom 用户 ID 不存在' }
      if (expectedName && !sameUser(name, expectedName)) {
        return {
          ok: false,
          text: '这个答案属于「' + name + '」，不是本页的用户',
        }
      }
      return readRecord(name).then(function (record) {
        if (!record)
          return { ok: false, text: '「' + name + '」还没生成验证码' }
        if (!sameUser(record.editor, name)) {
          return {
            ok: false,
            text: '「' + name + '」的验证页最后不是本人编辑的',
          }
        }
        var parts = ('' + record.content).replace(/^\s+|\s+$/g, '').split('#')
        if (parts.length !== 2) {
          return { ok: false, text: '验证码和「' + name + '」的验证页对不上' }
        }
        return SHA1(parts[0] + '#' + parsed.code).then(function (hash) {
          if (hash !== parts[1]) {
            return { ok: false, text: '验证码和「' + name + '」的验证页对不上' }
          }
          var minutes = Math.max(
            0,
            Math.floor((Date.now() - Number(parts[0])) / 60000)
          )
          var fresh = Date.now() - Number(parts[0]) <= CODE_TTL_MS
          return {
            ok: fresh,
            text:
              '答案属于「' +
              name +
              '」，生成于 ' +
              minutes +
              ' 分钟前' +
              (fresh ? '' : '，已超过 ' + CODE_TTL_LABEL),
          }
        })
      })
    })
  }

  // UI
  var CSS = [
    '.qqverify { --qqv-accent: var(--fandom-accent-color, #520044); margin: .75em 0 1em; border-left: 4px solid var(--qqv-accent); border-radius: 0 8px 8px 0; background: color-mix(in srgb, var(--qqv-accent) 6%, transparent); color: var(--fandom-text-color, #1e0c1b); line-height: 1.6; }',
    '.qqverify-bar { display: flex; flex-wrap: wrap; align-items: center; gap: .4em .8em; padding: .5em .9em; }',
    '.qqverify-icon { flex: none; font-size: 1.4em; line-height: 1; }',
    '.qqverify-lead { flex: 1; min-width: 12em; }',
    '.qqverify-actions { display: inline-flex; align-items: center; gap: .8em; }',
    '.qqverify-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 2em; padding: 0 1.1em; border: 1px solid var(--qqv-accent); border-radius: 999px; background: var(--qqv-accent); color: var(--fandom-accent-label-color, #fff); font-size: .95em; font-weight: bold; white-space: nowrap; cursor: pointer; }',
    '.qqverify-btn:hover { background: var(--fandom-accent-color--hover, var(--qqv-accent)); border-color: var(--fandom-accent-color--hover, var(--qqv-accent)); }',
    '.qqverify-btn:disabled { opacity: .55; cursor: default; }',
    '.qqverify-btn.is-secondary { background: var(--fandom-secondary-color, #fff); color: var(--qqv-accent); }',
    '.qqverify-btn.is-secondary:hover { background: var(--fandom-secondary-color--hover, #e2e2e2); }',
    '.qqverify-link { color: var(--fandom-text-color--secondary, #595358); font-size: .85em; cursor: pointer; white-space: nowrap; }',
    '.qqverify-link:hover { color: var(--fandom-link-color, #9b004e); text-decoration: underline; }',
    '.qqverify-panel { padding: 0 .9em .8em; }',
    '.qqverify-panel:empty, .qqverify-panel:empty + .qqverify-foot { display: none; }',
    '.qqverify-ticket { display: flex; flex-wrap: wrap; align-items: center; gap: .5em .8em; padding: .55em .5em .55em .9em; border: 1px dashed var(--qqv-accent); border-radius: 8px; background: var(--fandom-secondary-color, #fff); }',
    '.qqverify-ticket code { flex: 1; padding: 0; border: 0; background: none; color: inherit; font-size: 1.25em; font-weight: bold; letter-spacing: .04em; word-break: break-all; user-select: all; }',
    '.qqverify-tip { margin-top: .6em; padding: .5em .8em; border-radius: 6px; background: var(--fandom-secondary-color, #fff); color: var(--fandom-text-color--secondary, #595358); font-size: .92em; }',
    '.qqverify-tip b { color: var(--fandom-text-color, #1e0c1b); }',
    '.qqverify-error { color: #d73333; }',
    '.qqverify-admin { display: flex; flex-wrap: wrap; gap: .6em; margin-top: .6em; }',
    '.qqverify-admin input { flex: 1; min-width: 12em; padding: .3em .9em; border: 1px solid var(--fandom-border-color, #d6d0d5); border-radius: 999px; background: var(--fandom-secondary-color, #fff); color: inherit; font-size: 1em; }',
    '.qqverify-admin input:focus { border-color: var(--qqv-accent); outline: none; }',
    '.qqverify-verdict { flex-basis: 100%; font-weight: bold; }',
    '.qqverify-verdict.is-ok { color: var(--qqv-accent); }',
    '.qqverify-verdict.is-bad { color: #d73333; }',
    '.qqverify-foot { padding: 0 .9em .4em; color: var(--fandom-text-color--secondary, #595358); font-size: .75em; text-align: right; opacity: .7; }',
    '.qqverify-foot a { color: inherit; }',
  ].join('\n')

  function button(text, secondary) {
    return $('<button>', {
      type: 'button',
      class: 'qqverify-btn' + (secondary ? ' is-secondary' : ''),
      text: text,
    })
  }

  /**
   * The strip: one line with actions, a panel that expands below it.
   * Resolves nothing; returns { $el, $actions, show($content) }.
   */
  function Strip(lead) {
    var $actions = $('<span>', { class: 'qqverify-actions' })
    var $panel = $('<div>', { class: 'qqverify-panel' })
    var $el = $('<div>', { class: 'qqverify', id: 'QQVerifyBox' }).append(
      $('<div>', { class: 'qqverify-bar' }).append(
        $('<span>', { class: 'qqverify-icon', text: '🐧' }),
        $('<span>', { class: 'qqverify-lead', text: lead }),
        $actions
      ),
      $panel,
      $('<div>', { class: 'qqverify-foot' }).append(
        'Powered by ',
        $('<a>', {
          href: 'https://github.com/project-epb/SILI-agent',
          target: '_blank',
          text: 'SILI Agent',
        })
      )
    )
    var parts = { result: null, admin: null }
    // Keep the panel :empty while nothing is shown, so CSS hides it.
    function layout() {
      $panel.children().detach()
      if (parts.result) $panel.append(parts.result)
      if (parts.admin) $panel.append(parts.admin)
    }
    this.$el = $el
    this.$actions = $actions
    this.set = function (part, $content) {
      parts[part] = $content
      layout()
    }
  }

  function cooldown($button) {
    var left = REGENERATE_COOLDOWN_S
    function tick() {
      if (left <= 0) {
        $button.prop('disabled', false).text('重新生成')
        return
      }
      $button.text('重新生成（' + left-- + '）')
      setTimeout(tick, 1000)
    }
    tick()
  }

  function addGenerator(strip) {
    var $generate = button('生成加群码')
    $generate.on('click', function () {
      strip.set('result', null)
      $generate.prop('disabled', true).text('正在生成……')
      saveCode()
        .then(function (answer) {
          var $answer = $('<code>', { text: answer })
          var $copy = button('复制', true)
          $copy.on('click', function () {
            copyText(answer, $answer).then(function () {
              $copy.text('已复制')
              mw.notify($('<span>').html(NOTICE_HTML), {
                title: '加群码已复制',
                autoHideSeconds: 10,
              })
            })
          })
          strip.set(
            'result',
            $('<div>').append(
              $('<div>', { class: 'qqverify-ticket' }).append($answer, $copy),
              $('<div>', { class: 'qqverify-tip' }).html(NOTICE_HTML)
            )
          )
          cooldown($generate)
        })
        .catch(function (errorCode) {
          strip.set(
            'result',
            $('<div>', {
              class: 'qqverify-error',
              text: '保存失败：' + errorCode,
            })
          )
          $generate.prop('disabled', false).text('再试一次')
        })
    })
    strip.$actions.append($generate)
  }

  // expectedName: check against this user only (on their qq-hash page).
  function adminBox(expectedName) {
    var $input = $('<input>', {
      type: 'text',
      placeholder: '用户ID-加群码',
    })
    var $check = button('核对', true)
    var $verdict = $('<div>', { class: 'qqverify-verdict' })
    $check.on('click', function () {
      $verdict.removeClass('is-ok is-bad').empty()
      $check.prop('disabled', true).text('核对中……')
      checkAnswer($input.val(), expectedName)
        .then(function (res) {
          $verdict
            .addClass(res.ok ? 'is-ok' : 'is-bad')
            .text(
              (res.ok ? '✓ 匹配：' : '✗ 不通过：') +
                res.text +
                '；无法判断是否已被 bot 用过'
            )
        })
        .catch(function (errorCode) {
          $verdict.addClass('is-bad').text('核对失败：' + errorCode)
        })
        .then(function () {
          $check.prop('disabled', false).text('核对')
        })
    })
    $input.on('input', function () {
      $verdict.removeClass('is-ok is-bad').empty()
    })
    return $('<div>', { class: 'qqverify-admin' }).append(
      $input,
      $check,
      $verdict
    )
  }

  function addAdminToggle(strip, expectedName) {
    var $toggle = $('<a>', {
      class: 'qqverify-link',
      role: 'button',
      text: expectedName ? '核对此用户的答案' : '核对答案',
    })
    var open = false
    $toggle.on('click', function () {
      open = !open
      strip.set('admin', open ? adminBox(expectedName) : null)
    })
    strip.$actions.append($toggle)
  }

  // Main
  var isHashPage =
    pageName.indexOf('User:') === 0 &&
    pageName.slice(-QQ_HASH_SUFFIX.length) === QQ_HASH_SUFFIX
  var pageOwner = isHashPage
    ? pageName.split('/').shift().split(':').pop()
    : null
  var isOthersHashPage = isHashPage && !sameUser(pageOwner, userName)

  if (!isHashPage && !appRoot) return
  mw.loader.using(['mediawiki.util', 'mediawiki.notification']).then(render)

  function render() {
    mw.util.addCSS(CSS)

    // Someone else's qq-hash page: sysops check answers, others are warned off.
    if (isOthersHashPage) {
      if (!isAdmin) {
        $('#mw-content-text').prepend(
          $('<div>', { class: 'error', text: '警告：请勿修改他人的验证数据！' })
        )
        return
      }
      var check = new Strip('核对「' + pageOwner + '」的入群答案')
      addAdminToggle(check, pageOwner)
      $('#mw-content-text').prepend(check.$el)
      return
    }

    var strip = new Strip('申请加入 QQ 群前，请先生成一次性加群码')
    if (userName) {
      addGenerator(strip)
    } else {
      strip.$actions.append(
        $('<a>', {
          class: 'qqverify-btn',
          href: mw.util.getUrl('Special:UserLogin', {
            returnto: config.wgPageName,
          }),
          text: '登录后生成',
        })
      )
    }
    if (isAdmin && !isHashPage) addAdminToggle(strip, null)

    if (isHashPage) {
      $('#mw-content-text').prepend(strip.$el)
    } else {
      $(appRoot).empty().append(strip.$el)
    }
  }
})
