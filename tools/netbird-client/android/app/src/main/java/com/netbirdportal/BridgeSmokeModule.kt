package com.netbirdportal

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class BridgeSmokeModule(context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  override fun getName() = "BridgeSmoke"

  @ReactMethod
  fun echo(value: String, promise: Promise) {
    promise.resolve("echo:$value")
  }
}

class BridgeSmokePackage : com.facebook.react.ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext) =
    listOf(BridgeSmokeModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext) =
    emptyList<com.facebook.react.uimanager.ViewManager<*, *>>()
}
