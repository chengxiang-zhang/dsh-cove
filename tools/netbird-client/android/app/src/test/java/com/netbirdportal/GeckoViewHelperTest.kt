package com.netbirdportal

import org.junit.Assert.assertTrue
import org.junit.Test

class GeckoViewHelperTest {
  @Test
  fun configEnablesOfficialVoiceMediaApisForPrivateHttpOrigins() {
    val yaml = GeckoViewHelper.configYaml("127.0.0.1", 19001)

    assertTrue(yaml.contains("media.devices.insecure.enabled: true"))
    assertTrue(yaml.contains("media.getusermedia.insecure.enabled: true"))
    assertTrue(yaml.contains("network.proxy.http: \"127.0.0.1\""))
    assertTrue(yaml.contains("network.proxy.http_port: 19001"))
  }
}

