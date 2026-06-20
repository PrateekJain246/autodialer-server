# Add project specific ProGuard rules here.
# Keep the call screening service so the system can bind to it.
-keep class com.autodialer.callblocker.CallBlockerService { *; }
