package com.autodialer.callblocker

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Lightweight wrapper around SharedPreferences that stores the blocker
 * configuration and a small rolling log of recently blocked calls.
 */
object Prefs {

    private const val FILE = "call_blocker_prefs"
    private const val KEY_ENABLED = "blocking_enabled"
    private const val KEY_PREFIX = "block_prefix"
    private const val KEY_BLOCKED_COUNT = "blocked_count"
    private const val KEY_LOG = "blocked_log"

    private const val DEFAULT_PREFIX = "140"
    private const val MAX_LOG_ENTRIES = 50

    private fun prefs(context: Context) =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var Context.blockingEnabled: Boolean
        get() = prefs(this).getBoolean(KEY_ENABLED, true)
        set(value) = prefs(this).edit().putBoolean(KEY_ENABLED, value).apply()

    /** The dialled-number prefix that should be rejected (digits only). */
    fun blockPrefix(context: Context): String =
        prefs(context).getString(KEY_PREFIX, DEFAULT_PREFIX) ?: DEFAULT_PREFIX

    fun setBlockPrefix(context: Context, prefix: String) {
        val clean = prefix.filter { it.isDigit() }.ifEmpty { DEFAULT_PREFIX }
        prefs(context).edit().putString(KEY_PREFIX, clean).apply()
    }

    fun blockedCount(context: Context): Int =
        prefs(context).getInt(KEY_BLOCKED_COUNT, 0)

    /** Records a blocked call and returns the new total count. */
    fun recordBlocked(context: Context, number: String, timestamp: Long): Int {
        val p = prefs(context)
        val newCount = p.getInt(KEY_BLOCKED_COUNT, 0) + 1

        val log = JSONArray(p.getString(KEY_LOG, "[]"))
        val entry = JSONObject().apply {
            put("number", number)
            put("time", timestamp)
        }
        // Prepend newest first, then trim to the cap.
        val trimmed = JSONArray()
        trimmed.put(entry)
        for (i in 0 until minOf(log.length(), MAX_LOG_ENTRIES - 1)) {
            trimmed.put(log.getJSONObject(i))
        }

        p.edit()
            .putInt(KEY_BLOCKED_COUNT, newCount)
            .putString(KEY_LOG, trimmed.toString())
            .apply()
        return newCount
    }

    data class BlockedCall(val number: String, val time: Long)

    fun blockedLog(context: Context): List<BlockedCall> {
        val log = JSONArray(prefs(context).getString(KEY_LOG, "[]"))
        return (0 until log.length()).map { i ->
            val o = log.getJSONObject(i)
            BlockedCall(o.optString("number", "Unknown"), o.optLong("time", 0L))
        }
    }

    fun clearLog(context: Context) {
        prefs(context).edit()
            .putInt(KEY_BLOCKED_COUNT, 0)
            .putString(KEY_LOG, "[]")
            .apply()
    }
}
