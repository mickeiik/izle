package io.github.mickeiik.izle.ui

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Something shown for a while (Home's "No connection", the owner's banner): a new one replaces it and starts its time again. */
class TimedValue<T : Any>(private val scope: CoroutineScope) {
    private val _value = MutableStateFlow<T?>(null)

    /** What is showing, or null. */
    val value: StateFlow<T?> = _value.asStateFlow()

    private var job: Job? = null

    fun show(value: T, forMs: Long) {
        job?.cancel()
        _value.value = value
        job = scope.launch {
            delay(forMs)
            _value.value = null
        }
    }

    fun clear() {
        job?.cancel()
        _value.value = null
    }
}
