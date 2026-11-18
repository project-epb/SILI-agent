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
  function VerifyBox() {
    var $container = $('<div>', { id: 'verify-qq-container' })
    var $button = $('<button>', {
      text: '生成加群码',
      class: 'wds-button wds-primary',
    })
    var $error = $('<div>', { class: 'error' })
    var $result = $('<div>', { style: 'margin-top: 0.5em;' })
    $button.on('click', function (e) {
      e.preventDefault()
      $error.empty()
      $result.empty()
      $button.attr('disabled', '').text('正在生成')
      saveCode()
        .then(function (answer) {
          var $answer = $('<code>', {
            text: answer,
            style: 'font-size: 1.2em; user-select: all;',
          })
          var $copy = $('<button>', {
            text: '复制',
            class: 'wds-button wds-secondary',
            style: 'margin-left: 0.5em;',
          })
          $copy.on('click', function (ev) {
            ev.preventDefault()
            copyText(answer, $answer).then(function () {
              $copy.text('已复制')
              mw.notify($('<span>').html(NOTICE_HTML), {
                title: '加群码已复制',
                autoHideSeconds: 10,
              })
            })
          })
          $result.append(
            $('<div>').append('加群码：', $answer, $copy),
            $('<p>').html(NOTICE_HTML)
          )
          $button.removeAttr('disabled').text('重新生成')
        })
        .catch(function (errorCode) {
          $error.text('保存失败：' + errorCode)
          $button.removeAttr('disabled').text('再试一次')
        })
    })

    $container.append(
      $('<h2>', { text: '生成 QQ 群加群码' }),
      $button,
      $result,
      $error
    )
    this.App = $container
  }

  // expectedName: check against this user only (on their qq-hash page).
  function AdminVerifyBox(expectedName) {
    var $container = $('<div>', { id: 'verify-qq-admin-container' })
    var $input = $('<input>', {
      type: 'text',
      placeholder: '用户ID-验证码',
      style: 'display: block; width: 20em; padding: 0.2em 0.5em;',
    })
    var $button = $('<button>', {
      text: '核对',
      class: 'wds-button wds-primary',
    })
    var $result = $('<div>')

    $button.on('click', function (e) {
      e.preventDefault()
      $result.empty()
      $button.attr('disabled', '').text('核对中')
      checkAnswer($input.val(), expectedName)
        .then(function (res) {
          $result.append(
            $('<div>', {
              style: 'font-weight: bold; color: ' + (res.ok ? 'green' : 'red'),
              text: (res.ok ? '✓ 匹配：' : '✗ 不通过：') + res.text,
            }),
            $('<div>', {
              text: '这里无法判断答案是否已被 SILI 用过。',
              style: 'font-size: 0.85em; opacity: 0.7;',
            })
          )
        })
        .catch(function (errorCode) {
          $result.append(
            $('<div>', { class: 'error', text: '核对失败：' + errorCode })
          )
        })
        .then(function () {
          $button.removeAttr('disabled').text('核对')
        })
    })
    $input.on('input', function () {
      $result.empty()
    })

    $container.append(
      $('<h2>', { text: '核对入群答案' }),
      expectedName
        ? $('<div>').append('核对对象：', $('<code>', { text: expectedName }))
        : null,
      $('<div>', { style: 'display: flex; gap: 1em;' }).append($input, $button),
      $result
    )
    this.App = $container
  }

  // Main
  var isHashPage =
    pageName.indexOf('User:') === 0 &&
    pageName.slice(-QQ_HASH_SUFFIX.length) === QQ_HASH_SUFFIX
  var pageOwner = isHashPage
    ? pageName.split('/').shift().split(':').pop()
    : null

  // Someone else's qq-hash page: sysops check answers, others are warned off.
  if (isHashPage && !sameUser(pageOwner, userName)) {
    $('#mw-content-text').prepend(
      isAdmin
        ? new AdminVerifyBox(pageOwner).App
        : $('<div>', {
            id: 'verify-qq-container',
            class: 'error',
            text: '警告：请勿修改他人的验证数据！',
          })
    )
    return
  }

  if (!isHashPage && !appRoot) return

  var $app = userName
    ? new VerifyBox().App
    : $('<div>', {
        id: 'verify-qq-container',
        text: '请先登录后再使用该功能。',
      })
  var $admin = isAdmin && !isHashPage ? new AdminVerifyBox(null).App : null

  if (isHashPage) {
    $('#mw-content-text').prepend($app)
  } else {
    $(appRoot).empty().append($app, $admin)
  }
})
