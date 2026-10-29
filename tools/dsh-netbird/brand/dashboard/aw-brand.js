/**
 * Anywhere Work runtime skin for the management console.
 *
 * The console is the vendor's compiled Next.js export, so this is deliberately
 * conservative: it rewrites visible text, never markup structure, and never
 * touches attributes, because the React tree owns them. A text node whose value
 * we change is still a text node, and React will overwrite it on its next render
 * - which is why a MutationObserver re-applies the rules after client-side
 * navigation instead of doing a one-shot pass at load.
 *
 * What it does:
 *   1. retitles the document and keeps the title correct across route changes;
 *   2. rewrites the vendor's brand word to ours in *visible text only*;
 *   3. hides the vendor's own upsell bar and upstream-release pill;
 *   4. repoints the vendor's documentation links at our own onboarding page.
 *
 * What it deliberately does not do:
 *   - it does not rewrite the lowercase binary name, because that appears in
 *     commands, file paths and domains (`netbird up`, `.netbird`) where our
 *     product name would be actively wrong;
 *   - it does not touch text inside <code>, <pre>, <kbd>, <samp>, form fields or
 *     anything contenteditable, for the same reason - those are instructions the
 *     reader will type, not prose.
 */

(function () {
  'use strict'

  var PRODUCT = 'Anywhere Work'
  var VENDOR = 'NetBird'
  var VENDOR_LO = 'netbird'
  var DOCS_HOME = 'https://anywhere.example.com/client/'

  // Elements whose text is an instruction rather than prose. Rewriting the
  // vendor name inside these would produce commands that do not exist.
  var OPAQUE = ['CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA', 'INPUT', 'SCRIPT', 'STYLE']

  function isOpaque(node) {
    var el = node.parentElement
    while (el) {
      if (OPAQUE.indexOf(el.tagName) !== -1) {
        return true
      }
      if (el.isContentEditable) {
        return true
      }
      el = el.parentElement
    }
    return false
  }

  function retitle() {
    if (document.title.indexOf(VENDOR) === -1) {
      return
    }
    // "Peers - NetBird Dashboard" reads as "Peers - Anywhere Work".
    document.title = document.title.replace(/NetBird Dashboard/g, PRODUCT).replace(/NetBird/g, PRODUCT)
  }

  function rewriteText() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
    var node
    var changed = false
    while ((node = walker.nextNode())) {
      var value = node.nodeValue
      if (!value || value.indexOf(VENDOR) === -1 || isOpaque(node)) {
        continue
      }
      node.nodeValue = value.replace(/NetBird/g, PRODUCT)
      changed = true
    }
    return changed
  }

  /**
   * The console ships a bar promoting the vendor's own MDM rollout. It is
   * dismissible in their UI, but a dismissal is per-browser and per-storage, so
   * hiding it here is the only way it stays gone for everyone.
   */
  function hideVendorChrome() {
    // The bar has no stable hook, so it is found by its copy and then walked up
    // to the element that spans the viewport. It is matched on both the vendor
    // word and our own, because this runs again after client-side navigation and
    // by then the text has already been rewritten.
    var spans = document.querySelectorAll('span, div, p')
    for (var i = 0; i < spans.length; i += 1) {
      var text = spans[i].textContent || ''
      if (spans[i].children.length > 0) {
        continue
      }
      if (text.indexOf('Roll Out ' + VENDOR) === -1 && text.indexOf('Roll Out ' + PRODUCT) === -1) {
        continue
      }
      var bar = spans[i]
      for (var depth = 0; depth < 6 && bar.parentElement; depth += 1) {
        bar = bar.parentElement
        var rect = bar.getBoundingClientRect()
        if (rect.width >= window.innerWidth * 0.9 && rect.top < 80 && rect.height < 120) {
          bar.setAttribute('data-aw-hidden', 'true')
          break
        }
      }
    }

    // The vendor's own "a new release exists" pill. It IS the anchor (their own
// markup puts the pill styling on the <a>), so hiding an ancestor would also
// take the Management/Dashboard version rows with it. Hidden before the docs
// links are repointed, because repointing changes the href this matches on.
    var upgrade = document.querySelector('a[href*="docs.netbird.io/selfhosted/maintenance/upgrade"]')
    if (upgrade) {
      upgrade.setAttribute('data-aw-hidden', 'true')
    }

    // The vendor logo, served from a hashed path that the edge rewrites to our
    // own file. Its alt text is still theirs.
    var imgs = document.querySelectorAll('img[alt="NetBird Logo"]')
    for (var j = 0; j < imgs.length; j += 1) {
      imgs[j].setAttribute('alt', PRODUCT)
    }
  }

  /**
   * Our own users should not be sent to the vendor's documentation to learn how
   * to use our product: every "Learn more" and the nav's Documentation entry go
   * to the onboarding page we actually maintain.
   */
  function repointDocs() {
    var links = document.querySelectorAll('a[href*="docs.netbird.io"]')
    for (var i = 0; i < links.length; i += 1) {
      links[i].setAttribute('href', DOCS_HOME)
      links[i].setAttribute('rel', 'noreferrer')
    }
  }

  function apply() {
    // Order matters: the vendor's own chrome is identified by its copy and by its
    // documentation href, so it has to be hidden before either is rewritten.
    hideVendorChrome()
    retitle()
    rewriteText()
    repointDocs()
  }

  function start() {
    apply()

    // The console is a single-page app: a route change replaces the content
    // without a document load, so a one-shot pass would leave the new screen
    // unbranded. Coalesce bursts into one pass.
    var queued = false
    var observer = new MutationObserver(function () {
      if (queued) {
        return
      }
      queued = true
      window.requestAnimationFrame(function () {
        queued = false
        apply()
      })
    })
    observer.observe(document.body, {childList: true, subtree: true, characterData: true})

    // next/router updates the title after the observer's own work.
    var title = document.querySelector('title')
    if (title) {
      new MutationObserver(retitle).observe(title, {childList: true})
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()