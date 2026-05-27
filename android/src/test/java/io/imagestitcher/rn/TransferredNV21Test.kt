// SPDX-License-Identifier: Apache-2.0
package io.imagestitcher.rn

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Unit tests for the v0.10.0 audit #4A `TransferredNV21` single-use
 * ownership wrapper.  Pure-Kotlin tests; no Android device required.
 *
 * Run via:
 *
 *     gradlew :react-native-image-stitcher:test
 *
 * v0.10.0 PR A pins the invariants that protect against the misuse
 * pattern described in the wrapper's class docstring (a sync gate-eval
 * read AND an async workScope.launch consuming the same byte array).
 */
class TransferredNV21Test {

    @Test
    fun `constructor accepts non-empty byte array`() {
        val bytes = ByteArray(16) { it.toByte() }
        val wrapper = TransferredNV21(bytes)
        // Just check we can call takeOnce — exact byte contents verified separately.
        assertNotNull(wrapper.takeOnce())
    }

    @Test
    fun `constructor throws on empty byte array`() {
        val ex = assertThrows(IllegalArgumentException::class.java) {
            TransferredNV21(ByteArray(0))
        }
        // Message check: the wrapper should mention "zero-length" so
        // log readers can grep for it quickly.
        val message = ex.message ?: ""
        assert(message.contains("zero-length", ignoreCase = true)) {
            "Expected exception message to mention 'zero-length'; got: $message"
        }
    }

    @Test
    fun `takeOnce returns the original bytes on first call`() {
        val input = ByteArray(32) { it.toByte() }
        val wrapper = TransferredNV21(input)
        val out = wrapper.takeOnce()
        assertArrayEquals(input, out)
        // Identity: the wrapper returns the EXACT array reference
        // (no defensive copy).  The single-use contract makes this
        // safe — the caller is the new sole owner.
        assertSame(input, out)
    }

    @Test
    fun `takeOnce throws on second call`() {
        val wrapper = TransferredNV21(ByteArray(8))
        wrapper.takeOnce() // first call OK
        val ex = assertThrows(IllegalStateException::class.java) {
            wrapper.takeOnce()
        }
        // The error message documents the misuse pattern so a future
        // refactor introducing the bug surfaces it diagnosable in
        // logcat.
        val message = ex.message ?: ""
        assert(message.contains("called twice", ignoreCase = true)) {
            "Expected exception message to mention 'called twice'; got: $message"
        }
    }

    @Test
    fun `takeOnce is thread-safe — only one of N concurrent callers wins`() {
        // Stress the synchronized takeOnce path: spin up N threads,
        // each calling takeOnce() simultaneously.  Exactly one should
        // succeed; the rest should throw IllegalStateException.
        val threadCount = 16
        val wrapper = TransferredNV21(ByteArray(64) { it.toByte() })
        val executor = Executors.newFixedThreadPool(threadCount)
        val startLatch = CountDownLatch(1)
        val doneLatch = CountDownLatch(threadCount)
        val successCount = AtomicInteger(0)
        val failureCount = AtomicInteger(0)
        val capturedBytes = AtomicReference<ByteArray?>(null)

        try {
            repeat(threadCount) {
                executor.submit {
                    try {
                        startLatch.await()
                        try {
                            val bytes = wrapper.takeOnce()
                            successCount.incrementAndGet()
                            capturedBytes.set(bytes)
                        } catch (e: IllegalStateException) {
                            failureCount.incrementAndGet()
                        }
                    } catch (t: Throwable) {
                        fail("Unexpected throwable: $t")
                    } finally {
                        doneLatch.countDown()
                    }
                }
            }
            // Release all threads simultaneously.
            startLatch.countDown()
            assert(doneLatch.await(5, TimeUnit.SECONDS)) {
                "Timeout waiting for threads to complete"
            }
        } finally {
            executor.shutdownNow()
        }

        assertEquals("Exactly one thread should win takeOnce()", 1, successCount.get())
        assertEquals(
            "All other threads should throw IllegalStateException",
            threadCount - 1,
            failureCount.get(),
        )
        assertNotNull("The winning thread captured the bytes", capturedBytes.get())
    }

    @Test
    fun `two distinct wrappers are independent`() {
        val a = TransferredNV21(ByteArray(4) { 1 })
        val b = TransferredNV21(ByteArray(4) { 2 })
        val outA = a.takeOnce()
        val outB = b.takeOnce()
        assertNotSame(outA, outB)
        assertEquals(1.toByte(), outA[0])
        assertEquals(2.toByte(), outB[0])
        // After a's takeOnce, b is still extractable.
        // (Already extracted above; just confirm a is exhausted while
        // b's extraction succeeded.)
        assertThrows(IllegalStateException::class.java) { a.takeOnce() }
    }
}
