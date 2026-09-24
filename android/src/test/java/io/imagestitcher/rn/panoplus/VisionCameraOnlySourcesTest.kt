// SPDX-License-Identifier: Apache-2.0
//
// The package must build WITHOUT vision-camera. Every source that imports
// vision-camera or CameraX — both `compileOnly`, present only when the host
// has vision-camera — must be in android/build.gradle's `vcOnlySources`
// exclude list, or a consumer without vision-camera cannot compile this
// package at all (an unresolved import is a COMPILE error, and no runtime
// catch covers it). The list was once short by two files; M4 added a third
// such source (PanoPlusVcCameraControl.kt).

package io.imagestitcher.rn.panoplus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class VisionCameraOnlySourcesTest {

    @Test
    fun `every vision-camera or CameraX importer is excluded when vision-camera is absent`() {
        val gradle = File("build.gradle").readText()
        val listStart = gradle.indexOf("def vcOnlySources = [")
        assertTrue("vcOnlySources not found in build.gradle", listStart >= 0)
        val list = gradle.substring(listStart, gradle.indexOf("]", listStart))
        val excluded = Regex("'\\*\\*/([A-Za-z0-9_]+\\.kt)'").findAll(list).map { it.groupValues[1] }.toSet()

        val importers = File("src/main/java").walkTopDown()
            .filter { it.isFile && it.name.endsWith(".kt") }
            .filter { f ->
                f.readLines().any {
                    it.startsWith("import com.mrousavy.camera") || it.startsWith("import androidx.camera.")
                }
            }
            .map { it.name }
            .toSortedSet()

        assertTrue("found no importers — the scan is not reading the sources", importers.isNotEmpty())
        assertEquals(sortedSetOf<String>(), importers - excluded)
    }
}
