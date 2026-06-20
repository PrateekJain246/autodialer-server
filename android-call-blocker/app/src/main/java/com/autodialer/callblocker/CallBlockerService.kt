package com.autodialer.callblocker

import android.telecom.Call
import android.telecom.CallScreeningService
import android.util.Log
import com.autodialer.callblocker.Prefs.blockingEnabled

/**
 * Screens every incoming call. If blocking is enabled and the caller's number
 * starts with the configured prefix (140 by default — India's telemarketing
 * series), the call is silently rejected before it ever rings.
 */
class CallBlockerService : CallScreeningService() {

    override fun onScreenCall(callDetails: Call.Details) {
        // We only act on incoming calls; let everything else pass through.
        val isIncoming = callDetails.callDirection == Call.Details.DIRECTION_INCOMING
        val rawNumber = callDetails.handle?.schemeSpecificPart ?: ""

        if (!isIncoming) {
            allow(callDetails)
            return
        }

        if (!applicationContext.blockingEnabled) {
            allow(callDetails)
            return
        }

        val prefix = Prefs.blockPrefix(applicationContext)
        if (matchesPrefix(rawNumber, prefix)) {
            Log.i(TAG, "Blocking incoming call from $rawNumber (prefix $prefix)")
            block(callDetails)
            Prefs.recordBlocked(applicationContext, rawNumber, System.currentTimeMillis())
        } else {
            allow(callDetails)
        }
    }

    private fun allow(callDetails: Call.Details) {
        respondToCall(callDetails, CallResponse.Builder().build())
    }

    private fun block(callDetails: Call.Details) {
        val response = CallResponse.Builder()
            .setDisallowCall(true)      // do not let the call through
            .setRejectCall(true)        // actively reject (caller hears it end)
            .setSkipCallLog(false)      // still record it in the call log
            .setSkipNotification(true)  // no missed-call notification
            .build()
        respondToCall(callDetails, response)
    }

    companion object {
        private const val TAG = "CallBlockerService"

        /**
         * Returns true if [rawNumber] should be treated as starting with
         * [prefix]. The number is reduced to digits and common Indian
         * country-code / trunk-prefix variations are stripped so that
         * "+91 140-123-4567", "0140...", and "140..." all match a "140" rule.
         */
        fun matchesPrefix(rawNumber: String, prefix: String): Boolean {
            if (prefix.isEmpty()) return false
            val digits = rawNumber.filter { it.isDigit() }
            if (digits.isEmpty()) return false

            val candidates = linkedSetOf<String>()
            candidates.add(digits)

            // Strip a leading India country code (91) when present.
            if (digits.length > 10 && digits.startsWith("91")) {
                candidates.add(digits.substring(2))
            }
            // Strip a leading trunk/access "0".
            candidates.add(digits.trimStart('0'))

            return candidates.any { it.startsWith(prefix) }
        }
    }
}
