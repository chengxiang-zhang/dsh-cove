package com.netbirdportal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The finished-run rules, exercised on the JVM.
 *
 * These tests pin the parts that decide whether a phone buzzes: the watermark
 * reconciliation around a restarted host, the defensive read of a feed that a
 * not-yet-updated machine answers with a 404 or a broken body, and the exact
 * text of the one notification per poll.
 */
class RunNotificationTest {

  // ---- watermark ----------------------------------------------------------

  @Test
  fun `first read stores the newest id as the baseline`() {
    val selection = WatermarkRule.select(
      notices = listOf(notice(3, RunOutcome.COMPLETED), notice(4, RunOutcome.FAILED)),
      previous = 0,
      latest = 4,
      baseline = true,
    )
    assertTrue(selection.notices.isEmpty())
    assertEquals(4, selection.watermark)
  }

  @Test
  fun `first read with no notices keeps the stored watermark`() {
    val selection = WatermarkRule.select(
      notices = emptyList(),
      previous = 7,
      latest = 0,
      baseline = true,
    )
    assertTrue(selection.notices.isEmpty())
    assertEquals(7, selection.watermark)
  }

  @Test
  fun `incremental read reports only what is newer`() {
    val selection = WatermarkRule.select(
      notices = listOf(
        notice(4, RunOutcome.COMPLETED),
        notice(5, RunOutcome.COMPLETED),
        notice(6, RunOutcome.STOPPED),
        notice(7, RunOutcome.FAILED),
      ),
      previous = 4,
      latest = 7,
      baseline = false,
    )
    assertEquals(listOf(5, 7), selection.notices.map { it.id })
    assertEquals(7, selection.watermark)
  }

  @Test
  fun `an unchanged watermark reports nothing`() {
    val selection = WatermarkRule.select(
      notices = listOf(notice(9, RunOutcome.COMPLETED)),
      previous = 9,
      latest = 9,
      baseline = false,
    )
    assertTrue(selection.notices.isEmpty())
    assertEquals(9, selection.watermark)
  }

  @Test
  fun `a host restart starts over instead of hiding every future notice`() {
    // Stored against the previous host process; the restarted host serves ids
    // from 1 again. Keeping 12 would silence this machine forever.
    assertEquals(0, WatermarkRule.reconcile(previous = 12, latest = 2))
    val selection = WatermarkRule.select(
      notices = listOf(notice(1, RunOutcome.COMPLETED), notice(2, RunOutcome.COMPLETED)),
      previous = 12,
      latest = 2,
      baseline = false,
    )
    assertEquals(listOf(1, 2), selection.notices.map { it.id })
    assertEquals(2, selection.watermark)
  }

  @Test
  fun `a nonsense watermark is treated as nothing seen yet`() {
    assertEquals(0, WatermarkRule.clamp(-5))
    assertEquals(0, WatermarkRule.clamp(null))
    assertEquals(4, WatermarkRule.clamp(4))
    assertEquals(0, WatermarkRule.reconcile(previous = 0, latest = 3))
  }

  // ---- what deserves attention -------------------------------------------

  @Test
  fun `stopped runs are never notifiable`() {
    assertTrue(RunOutcome.COMPLETED.notifiable)
    assertTrue(RunOutcome.FAILED.notifiable)
    assertFalse(RunOutcome.STOPPED.notifiable)

    val selection = WatermarkRule.select(
      notices = listOf(
        notice(1, RunOutcome.STOPPED),
        notice(2, RunOutcome.STOPPED),
      ),
      previous = 0,
      latest = 2,
      baseline = false,
    )
    assertTrue(selection.notices.isEmpty())
    assertEquals(2, selection.watermark)
  }

  @Test
  fun `an unknown reason collapses to the neutral outcome`() {
    assertEquals(RunOutcome.COMPLETED, RunOutcome.ofReason("completed"))
    assertEquals(RunOutcome.COMPLETED, RunOutcome.ofReason("max-tokens"))
    assertEquals(RunOutcome.FAILED, RunOutcome.ofReason("error"))
    assertEquals(RunOutcome.FAILED, RunOutcome.ofReason("blocked"))
    assertEquals(RunOutcome.STOPPED, RunOutcome.ofReason("forked"))
    assertEquals(RunOutcome.STOPPED, RunOutcome.ofReason("some-plugin-reason"))
    assertEquals(RunOutcome.STOPPED, RunOutcome.ofReason(""))
    assertEquals(RunOutcome.STOPPED, RunOutcome.ofReason(null))
  }

  @Test
  fun `the wire outcome wins and falls back to the reason`() {
    assertEquals(RunOutcome.FAILED, RunOutcome.parse("failed", "completed"))
    assertEquals(RunOutcome.COMPLETED, RunOutcome.parse("completed", "error"))
    assertEquals(RunOutcome.FAILED, RunOutcome.parse(null, "error"))
    assertEquals(RunOutcome.COMPLETED, RunOutcome.parse("  ", "max-tokens"))
    assertEquals(RunOutcome.STOPPED, RunOutcome.parse("nonsense", "nonsense"))
  }

  // ---- parsing, including everything that must stay silent ----------------

  @Test
  fun `a well formed feed is narrowed`() {
    val feed = NotifyFeedJson.parse(
      """
      {"origin":"dsh.foo.netbird","latest":12,"notices":[
        {"id":12,"at":1760000000000,"sessionId":"session-3","title":"修一下登录页",
         "turn":4,"reason":"completed","outcome":"completed"}
      ]}
      """.trimIndent(),
    )
    assertNotNull(feed)
    assertEquals(12, feed!!.latest)
    assertEquals(1, feed.notices.size)
    assertEquals(12, feed.notices[0].id)
    assertEquals(1760000000000L, feed.notices[0].at)
    assertEquals("session-3", feed.notices[0].sessionId)
    assertEquals("修一下登录页", feed.notices[0].title)
    assertEquals(4, feed.notices[0].turn)
    assertEquals(RunOutcome.COMPLETED, feed.notices[0].outcome)
  }

  @Test
  fun `absent fields degrade instead of throwing`() {
    val feed = NotifyFeedJson.parse("""{"notices":[{"id":3}]}""")
    assertNotNull(feed)
    assertEquals(3, feed!!.latest)
    val notice = feed.notices.single()
    assertEquals("", notice.title)
    assertEquals("", notice.sessionId)
    assertEquals(RunOutcome.STOPPED, notice.outcome)
    assertEquals(0L, notice.at)
  }

  @Test
  fun `a malformed payload has nothing to notify`() {
    assertNull(NotifyFeedJson.parse(null))
    assertNull(NotifyFeedJson.parse(""))
    assertNull(NotifyFeedJson.parse("   "))
    assertNull(NotifyFeedJson.parse("{"))
    assertNull(NotifyFeedJson.parse("not json at all"))
    assertNull(NotifyFeedJson.parse("[]"))
    assertNull(NotifyFeedJson.parse("404 page not found"))
    // A document that parses but carries neither feed key is a proxy error page
    // or a login page, not an empty feed.
    assertNull(NotifyFeedJson.parse("""{"hello":"world"}"""))
    assertNull(NotifyFeedJson.parse("{}"))
    assertNotNull(NotifyFeedJson.parse("""{"latest":0}"""))
    assertNotNull(NotifyFeedJson.parse("""{"notices":[]}"""))
  }

  @Test
  fun `a machine that answers 404 is silent and keeps the watermark`() {
    // Portal.fetch does not throw on a non-2xx status, so the status has to be
    // read here. Nothing about a 404 may reach the user or the watermark.
    assertNull(
      NotifyFeedJson.parseEnvelope(
        """{"url":"http://dsh.foo.netbird/api/dsh-notify/feed","statusCode":404,"body":"404 page not found"}""",
      ),
    )
    assertNull(NotifyFeedJson.parseEnvelope("""{"statusCode":500,"body":"{}"}"""))
    assertNull(NotifyFeedJson.parseEnvelope(null))
    assertNull(NotifyFeedJson.parseEnvelope(""))
    assertNull(NotifyFeedJson.parseEnvelope("<html>"))
    assertNotNull(
      NotifyFeedJson.parseEnvelope(
        """{"url":"http://dsh.foo.netbird/api/dsh-notify/feed","statusCode":200,"body":"{\"latest\":2,\"notices\":[{\"id\":2,\"reason\":\"completed\"}]}"}""",
      ),
    )
  }

  @Test
  fun `an empty notice list is a feed, not a failure`() {
    val feed = NotifyFeedJson.parse("""{"origin":"dsh.foo.netbird","latest":9,"notices":[]}""")
    assertNotNull(feed)
    assertEquals(9, feed!!.latest)
    assertTrue(feed.notices.isEmpty())
  }

  @Test
  fun `a truncated field never throws`() {
    val feed = NotifyFeedJson.parse("""{"latest":"x","notices":[{"id":"y","title":42,"turn":null}]}""")
    assertNotNull(feed)
    val notice = feed!!.notices.single()
    assertEquals(0, notice.id)
    assertEquals("", notice.title)
    // The unusable `latest` falls back to what the notices themselves say.
    assertEquals(0, feed.latest)
  }

  @Test
  fun `an unusable latest falls back to the newest notice id`() {
    val feed = NotifyFeedJson.parse("""{"latest":"nope","notices":[{"id":5},{"id":8}]}""")
    assertNotNull(feed)
    assertEquals(8, feed!!.latest)
  }

  // ---- the text -----------------------------------------------------------

  @Test
  fun `one completed run collapses into one summary naming the machine`() {
    val summary = RunNotificationSummaryFactory.of(
      "dsh.studio-mac.netbird",
      listOf(notice(12, RunOutcome.COMPLETED, "修一下登录页")),
    )
    assertNotNull(summary)
    assertEquals("修一下登录页", summary!!.title)
    assertEquals(1, summary.completed)
    assertEquals(0, summary.failed)
    assertEquals(1, summary.total)
  }

  @Test
  fun `several finished runs collapse into one summary that counts them`() {
    val summary = RunNotificationSummaryFactory.of(
      "dsh.studio-mac.netbird",
      listOf(
        notice(1, RunOutcome.COMPLETED, "旧的"),
        notice(2, RunOutcome.FAILED, "出错的那个"),
        notice(3, RunOutcome.COMPLETED, "最新的一个"),
        notice(4, RunOutcome.STOPPED, "被中断的"),
      ),
    )
    assertNotNull(summary)
    assertEquals("最新的一个", summary!!.title)
    assertEquals(2, summary.completed)
    assertEquals(1, summary.failed)
    assertEquals(3, summary.total)
  }

  @Test
  fun `a failed run is reported as a failure`() {
    val summary = RunNotificationSummaryFactory.of(
      "dsh.laptop-b.netbird",
      listOf(notice(7, RunOutcome.FAILED, "部署脚本")),
    )
    assertNotNull(summary)
    assertEquals(0, summary!!.completed)
    assertEquals(1, summary.failed)
  }

  @Test
  fun `a blank title falls back to the machine`() {
    val summary = RunNotificationSummaryFactory.of(
      "dsh.studio-mac.netbird",
      listOf(notice(1, RunOutcome.COMPLETED, "  ")),
    )
    assertNotNull(summary)
    assertEquals("dsh.studio-mac.netbird", summary!!.title)
  }

  @Test
  fun `nothing notifiable produces no summary`() {
    assertNull(RunNotificationSummaryFactory.of("dsh.studio-mac.netbird", emptyList()))
    assertNull(
      RunNotificationSummaryFactory.of(
        "dsh.studio-mac.netbird",
        listOf(notice(1, RunOutcome.STOPPED)),
      ),
    )
  }

  // ---- the request --------------------------------------------------------

  @Test
  fun `the feed url carries the stored watermark`() {
    assertEquals(
      "http://dsh.studio-mac.netbird/api/dsh-notify/feed?since=0&limit=20",
      RunNotifications.feedUrl("dsh.studio-mac.netbird", 0),
    )
    assertEquals(
      "http://dsh.studio-mac.netbird/api/dsh-notify/feed?since=12&limit=20",
      RunNotifications.feedUrl("dsh.studio-mac.netbird", 12),
    )
    // A corrupt stored value never becomes a request the host cannot answer.
    assertEquals(
      "http://dsh.studio-mac.netbird/api/dsh-notify/feed?since=0&limit=20",
      RunNotifications.feedUrl("dsh.studio-mac.netbird", -3),
    )
  }

  // ---- the enable switch --------------------------------------------------

  @Test
  fun `the switch defaults to enabled`() {
    // Long work started from the phone should report back without the user
    // having to find a setting first; an explicit off is what disables it.
    assertTrue(RunNotificationStore.ENABLED_BY_DEFAULT)
  }

  private fun notice(
    id: Int,
    outcome: RunOutcome,
    title: String = "t$id",
  ) = RunNotice(
    id = id,
    at = 1_760_000_000_000L,
    sessionId = "session-$id",
    title = title,
    turn = 1,
    reason = outcome.wire,
    outcome = outcome,
  )
}