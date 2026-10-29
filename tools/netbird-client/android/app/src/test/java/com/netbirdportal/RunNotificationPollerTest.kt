package com.netbirdportal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The poll loop, driven through a fake [RunNotificationState].
 *
 * These pin the parts a device would otherwise be needed for: that the first
 * pass only establishes a baseline, that a later pass notifies once for a whole
 * batch, that a poll with nothing new says nothing, that the switch silences
 * everything, and that a machine which is not updated yet (404) is invisible.
 */
class RunNotificationPollerTest {

  private val host = "dsh.studio-mac.netbird"

  private class FakeState(
    var enabled: Boolean = true,
    var connected: Boolean = true,
    var hosts: Set<String>? = setOf("dsh.studio-mac.netbird"),
    var body: (String) -> String? = { null },
    var clock: Long = 1_000_000L,
  ) : RunNotificationState {
    val watermarks = mutableMapOf<String, Int>()
    var rememberedHost: String? = null
    val requests = mutableListOf<String>()

    override fun notificationsEnabled() = enabled
    override fun connected() = connected
    override fun acceptedHosts() = hosts
    override fun watermark(host: String) = WatermarkRule.clamp(watermarks[host])
    override fun saveWatermark(host: String, watermark: Int) {
      watermarks[host] = watermark
    }
    override fun rememberHost(host: String) {
      rememberedHost = host
    }
    override fun fetch(url: String): String {
      requests.add(url)
      return body(url) ?: throw IllegalStateException("no response")
    }
    override fun now() = clock
  }

  private class Recorder : RunNotificationPoller.Listener {
    val posted = mutableListOf<RunNotificationSummary>()
    var cleared = 0

    override fun onRunFinished(summary: RunNotificationSummary) {
      posted.add(summary)
    }

    override fun onRunNotificationsCleared() {
      cleared += 1
    }
  }

  private fun envelope(body: String, statusCode: Int = 200) =
    """{"url":"http://$host/api/dsh-notify/feed","statusCode":$statusCode,"body":${quote(body)}}"""

  private fun quote(value: String) = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

  private fun feed(vararg notices: String, latest: Int) =
    """{"origin":"dsh.foo.netbird","latest":$latest,"notices":[${notices.joinToString(",")}]}"""

  private fun notice(id: Int, outcome: String, title: String) =
    """{"id":$id,"at":1760000000000,"sessionId":"session-$id","title":"$title","turn":1,"reason":"$outcome","outcome":"$outcome"}"""

  private fun poller(state: FakeState, recorder: Recorder) =
    RunNotificationPoller(state, recorder)

  /**
   * One baseline pass, which every real connection performs before anything can
   * be reported. A test that wants the incremental path has to get past it
   * first, exactly as the service does after a reconnect.
   */
  private fun warmedUp(state: FakeState, recorder: Recorder): RunNotificationPoller {
    val poller = poller(state, recorder)
    poller.tick()
    assertTrue(recorder.posted.isEmpty())
    return poller
  }

  @Test
  fun `the first pass only establishes a baseline`() {
    val state = FakeState(body = {
      envelope(feed(notice(1, "completed", "很久以前"), notice(2, "completed", "刚才"), latest = 2))
    })
    val recorder = Recorder()

    poller(state, recorder).tick()

    assertTrue(recorder.posted.isEmpty())
    assertEquals(2, state.watermarks[host])
    // The poll asked for everything the host holds, because nothing was seen yet.
    assertEquals(
      listOf("http://$host/api/dsh-notify/feed?since=0&limit=20"),
      state.requests,
    )
  }

  @Test
  fun `a later pass notifies once for the whole batch`() {
    // The baseline pass sees the host up to id 2; the batch that finished
    // afterwards is what the next pass has to collapse into one notice.
    var body = envelope(feed(notice(2, "completed", "更早的"), latest = 2))
    val state = FakeState(body = { body })
    val recorder = Recorder()
    val poller = warmedUp(state, recorder)
    assertEquals(2, state.watermarks[host])
    state.requests.clear()
    body = envelope(
      feed(
        notice(3, "completed", "旧的"),
        notice(4, "completed", "最新的一个"),
        notice(5, "failed", "出错的"),
        latest = 5,
      ),
    )

    poller.tick()

    assertEquals(1, recorder.posted.size)
    val summary = recorder.posted.single()
    assertEquals(host, summary.host)
    assertEquals("出错的", summary.title)
    assertEquals(2, summary.completed)
    assertEquals(1, summary.failed)
    assertEquals(3, summary.total)
    assertEquals(5, state.watermarks[host])
    assertEquals(host, state.rememberedHost)
    assertEquals(
      listOf("http://$host/api/dsh-notify/feed?since=2&limit=20"),
      state.requests,
    )
  }

  @Test
  fun `a second pass with nothing new says nothing`() {
    val state = FakeState(body = {
      envelope(feed(notice(5, "completed", "最新的一个"), latest = 5))
    })
    state.watermarks[host] = 5
    val recorder = Recorder()

    poller(state, recorder).tick()

    assertTrue(recorder.posted.isEmpty())
    assertEquals(5, state.watermarks[host])
  }

  @Test
  fun `finished work on two machines is reported one per tick, never dropped`() {
    val first = "dsh.a.netbird"
    val second = "dsh.b.netbird"
    var newestId = 8
    val state = FakeState(hosts = setOf(second, first), body = { url ->
      val name = url.substringAfter("http://").substringBefore("/")
      envelope(feed(notice(newestId, "completed", "在 $name 上跑完"), latest = newestId))
    })
    state.watermarks[first] = 8
    state.watermarks[second] = 8
    val recorder = Recorder()
    val poller = warmedUp(state, recorder)

    // Both machines finish one more turn. One notification per tick, and it is
    // the alphabetically first machine.
    newestId = 9
    poller.tick()
    assertEquals(1, recorder.posted.size)
    assertEquals(first, recorder.posted.single().host)
    assertEquals(first, state.rememberedHost)
    // The other machine was not advanced past, so its work is still pending.
    assertEquals(9, state.watermarks[first])
    assertEquals(8, state.watermarks[second])

    // The next tick reports the machine that was skipped, not the same one again.
    poller.tick()
    assertEquals(2, recorder.posted.size)
    assertEquals(second, recorder.posted.last().host)
    assertEquals(9, state.watermarks[second])

    // Nothing left: a third tick says nothing.
    poller.tick()
    assertEquals(2, recorder.posted.size)
  }

  @Test
  fun `the switch off means no polling and no notification`() {
    val state = FakeState(enabled = false, body = {
      envelope(feed(notice(3, "completed", "x"), latest = 3))
    })
    state.watermarks[host] = 2
    val recorder = Recorder()

    poller(state, recorder).tick()

    assertTrue(state.requests.isEmpty())
    assertTrue(recorder.posted.isEmpty())
    assertEquals(2, state.watermarks[host])
  }

  @Test
  fun `switching off withdraws a notification that is already up`() {
    val state = FakeState(body = {
      envelope(feed(notice(3, "completed", "x"), latest = 3))
    })
    val recorder = Recorder()
    val poller = poller(state, recorder)
    poller.tick()
    recorder.posted.clear()

    state.enabled = false
    poller.tick()

    assertEquals(1, recorder.cleared)
    assertTrue(recorder.posted.isEmpty())
  }

  @Test
  fun `a disconnected overlay polls nothing`() {
    val state = FakeState(connected = false, body = {
      envelope(feed(notice(3, "completed", "x"), latest = 3))
    })
    state.watermarks[host] = 2
    val recorder = Recorder()

    poller(state, recorder).tick()

    assertTrue(state.requests.isEmpty())
    assertTrue(recorder.posted.isEmpty())
    assertEquals(2, state.watermarks[host])
  }

  @Test
  fun `reconnecting re-baselines instead of replaying the history`() {
    val state = FakeState(body = {
      envelope(feed(notice(10, "completed", "在离开期间跑完的"), latest = 10))
    })
    state.watermarks[host] = 2
    val recorder = Recorder()
    val poller = poller(state, recorder)

    state.connected = false
    poller.tick()
    state.connected = true
    poller.tick()

    assertTrue(recorder.posted.isEmpty())
    assertEquals(10, state.watermarks[host])
  }

  @Test
  fun `a machine that is not updated yet is invisible`() {
    val state = FakeState(body = { envelope("404 page not found", statusCode = 404) })
    state.watermarks[host] = 7
    val recorder = Recorder()

    poller(state, recorder).tick()

    assertTrue(recorder.posted.isEmpty())
    assertEquals(7, state.watermarks[host])
  }

  @Test
  fun `a fetch failure leaves the watermark alone`() {
    val state = FakeState(body = { null })
    state.watermarks[host] = 7
    val recorder = Recorder()

    poller(state, recorder).tick()

    assertTrue(recorder.posted.isEmpty())
    assertEquals(7, state.watermarks[host])
  }

  @Test
  fun `an empty host set polls nothing`() {
    val state = FakeState(hosts = emptySet())
    val recorder = Recorder()

    poller(state, recorder).tick()

    assertTrue(state.requests.isEmpty())
    assertTrue(recorder.posted.isEmpty())
  }

  @Test
  fun `a host that only serves stopped turns is read once, not every tick`() {
    var revision = 4
    val state = FakeState(body = {
      envelope(feed(notice(revision, "stopped", "被中断的"), latest = revision))
    })
    val recorder = Recorder()
    val poller = warmedUp(state, recorder)
    revision = 5
    state.requests.clear()

    poller.tick()

    assertTrue(recorder.posted.isEmpty())
    // Reconciled away rather than notified about, so the read moves on.
    assertEquals(5, state.watermarks[host])
    assertEquals(
      listOf("http://$host/api/dsh-notify/feed?since=4&limit=20"),
      state.requests,
    )
  }

  @Test
  fun `a failed discovery keeps the host set it already had`() {
    var newestId = 8
    val state = FakeState(body = {
      envelope(feed(notice(newestId, "completed", "跑完了"), latest = newestId))
    })
    val recorder = Recorder()
    val poller = warmedUp(state, recorder)

    // Discovery starts failing. The alerts must keep working from the last good
    // set instead of going silent until the control plane answers again.
    state.hosts = null
    state.clock += RunNotificationPoller.HOSTS_REFRESH_SECONDS * 1000 + 1
    newestId = 9
    poller.tick()

    assertEquals(1, recorder.posted.size)
    assertEquals(host, recorder.posted.single().host)
    assertEquals(9, state.watermarks[host])
  }

  @Test
  fun `discovery is not re-read on every tick`() {
    var discoveries = 0
    val state = object : RunNotificationState {
      override fun notificationsEnabled() = true
      override fun connected() = true
      override fun acceptedHosts(): Set<String>? {
        discoveries += 1
        return setOf(host)
      }
      override fun watermark(host: String) = 0
      override fun saveWatermark(host: String, watermark: Int) {}
      override fun rememberHost(host: String) {}
      override fun fetch(url: String): String =
        """{"statusCode":200,"body":"{\"latest\":1,\"notices\":[]}"}"""
      override fun now() = 1_000_000L
    }
    val poller = RunNotificationPoller(state, Recorder())

    poller.tick()
    poller.tick()
    poller.tick()

    assertEquals(1, discoveries)
  }

  @Test
  fun `a host restart is reported through the poll loop`() {
    val state = FakeState(body = {
      envelope(feed(notice(1, "completed", "重启之前"), latest = 1))
    })
    // The watermark stored against the previous host process.
    state.watermarks[host] = 12
    val recorder = Recorder()
    val poller = poller(state, recorder)

    poller.tick()
    assertEquals(1, state.watermarks[host])
    assertTrue(recorder.posted.isEmpty())

    state.body = { envelope(feed(notice(2, "completed", "重启之后"), latest = 2)) }
    poller.tick()

    assertEquals(1, recorder.posted.size)
    assertEquals("重启之后", recorder.posted.single().title)
    assertEquals(2, state.watermarks[host])
  }
}