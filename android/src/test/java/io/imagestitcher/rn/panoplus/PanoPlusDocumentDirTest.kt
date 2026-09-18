// SPDX-License-Identifier: Apache-2.0
//
// ⚠ THE FORMAT THAT LETS THIS PACKAGE STOP DEPENDING ON EXPO.
//
// pano+ moved into this Apache-2.0 package still reading its base directory
// from `expo-file-system`, which this package neither depends on nor
// declares. A plain React Native host — including this repo's own example
// app — got the card "pano+ is not available", a sentence about the BUILD,
// for a missing peer dependency nobody had mentioned. The build was fine.
//
// `RNSSweepSession` now exports the directory itself. The only part of that
// which can be WRONG is the string's shape, and it has a real contract: JS
// concatenates a session name straight onto it, and `barePath()` strips the
// `file://` scheme back off. It must match what Expo reports byte for byte,
// or a host that swaps between the two moves its data without being told.

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PanoPlusDocumentDirTest {

    @Test
    fun `matches the expo-file-system spelling exactly`() {
        // What expo-file-system reports on Android, verbatim.
        assertEquals(
            "file:///data/user/0/com.example.app/files/",
            PanoPlusLiveModule.documentDirectoryUri("/data/user/0/com.example.app/files"),
        )
    }

    @Test
    fun `a trailing slash is added, never doubled`() {
        // `File.getAbsolutePath()` does not return a trailing slash today, but
        // appending one unconditionally would produce `files//` the day it
        // does, and `file://x//y` is a different path to some consumers.
        assertEquals(
            PanoPlusLiveModule.documentDirectoryUri("/data/app/files"),
            PanoPlusLiveModule.documentDirectoryUri("/data/app/files/"),
        )
    }

    @Test
    fun `concatenating a session name yields a child, not a sibling`() {
        // THE failure a missing trailing slash causes: not an error, a
        // silently WRONG path. `…/filessweep-1` is a sibling of the files
        // directory, is writable, and nothing downstream would complain.
        val dir = PanoPlusLiveModule.documentDirectoryUri("/data/user/0/app/files")
        assertEquals("file:///data/user/0/app/files/sweep-1", dir + "sweep-1")
    }

    @Test
    fun `carries the scheme barePath expects to strip`() {
        val dir = PanoPlusLiveModule.documentDirectoryUri("/data/app/files")
        assertTrue(dir.startsWith("file://"))
        // And exactly three slashes after the scheme's two — an absolute path
        // appended to `file://` is what makes `file:///…`. A relative path
        // here would produce `file://data/…`, where `data` is read as a HOST.
        assertTrue(dir.startsWith("file:///"))
    }
}
