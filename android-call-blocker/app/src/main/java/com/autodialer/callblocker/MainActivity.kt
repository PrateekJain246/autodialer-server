package com.autodialer.callblocker

import android.app.role.RoleManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.text.format.DateFormat
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.autodialer.callblocker.Prefs.blockingEnabled
import com.autodialer.callblocker.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding

    private val roleLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            refreshUi()
            if (isScreeningRoleHeld()) {
                toast(getString(R.string.role_granted))
            } else {
                toast(getString(R.string.role_denied))
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.switchEnabled.setOnCheckedChangeListener { _, checked ->
            applicationContext.blockingEnabled = checked
            refreshUi()
        }

        binding.buttonSavePrefix.setOnClickListener {
            val text = binding.editPrefix.text?.toString()?.trim().orEmpty()
            Prefs.setBlockPrefix(this, text)
            binding.editPrefix.setText(Prefs.blockPrefix(this))
            toast(getString(R.string.prefix_saved, Prefs.blockPrefix(this)))
            refreshUi()
        }

        binding.buttonGrantRole.setOnClickListener { requestScreeningRole() }

        binding.buttonClearLog.setOnClickListener {
            Prefs.clearLog(this)
            refreshUi()
        }
    }

    override fun onResume() {
        super.onResume()
        refreshUi()
    }

    private fun refreshUi() {
        binding.switchEnabled.isChecked = applicationContext.blockingEnabled
        binding.editPrefix.setText(Prefs.blockPrefix(this))
        binding.textBlockedCount.text =
            getString(R.string.blocked_count, Prefs.blockedCount(this))

        binding.textRoleStatus.text = when {
            !roleSupported() -> getString(R.string.role_status_legacy)
            isScreeningRoleHeld() -> getString(R.string.role_status_active)
            else -> getString(R.string.role_status_inactive)
        }
        binding.buttonGrantRole.isEnabled = roleSupported() && !isScreeningRoleHeld()

        binding.textLog.text = buildLogText()
    }

    private fun buildLogText(): String {
        val entries = Prefs.blockedLog(this)
        if (entries.isEmpty()) return getString(R.string.log_empty)
        return entries.joinToString("\n") { e ->
            val time = DateFormat.format("MMM d, h:mm a", e.time)
            "• ${e.number}  —  $time"
        }
    }

    private fun requestScreeningRole() {
        if (!roleSupported()) {
            toast(getString(R.string.role_status_legacy))
            return
        }
        val roleManager = getSystemService(Context.ROLE_SERVICE) as RoleManager
        if (roleManager.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)) {
            toast(getString(R.string.role_granted))
            return
        }
        val intent = roleManager.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING)
        roleLauncher.launch(intent)
    }

    private fun isScreeningRoleHeld(): Boolean {
        if (!roleSupported()) return true // pre-Q binds the service automatically
        val roleManager = getSystemService(Context.ROLE_SERVICE) as RoleManager
        return roleManager.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
    }

    private fun roleSupported(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    private fun toast(message: String) =
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
}
