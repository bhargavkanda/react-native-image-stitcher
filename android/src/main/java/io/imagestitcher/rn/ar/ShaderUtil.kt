// SPDX-License-Identifier: UNLICENSED
package io.imagestitcher.rn.ar

import android.opengl.GLES20

/**
 * Minimal GLSL compile + link helper.  Shared by the BackgroundRenderer
 * (and any future GL stages we add).  Keeps the per-renderer code
 * focused on what's drawn rather than on GLSL boilerplate.
 *
 * No Android Studio or hello_ar dependency — small enough to inline.
 */
internal object ShaderUtil {

    /**
     * Compile a vertex + fragment shader pair and link into a GL
     * program.  Throws on any compile/link error with the GL log
     * attached to the message — much more useful than the bare
     * GL_FALSE return that GLES20 hands you.
     */
    fun loadGLProgram(vertexSrc: String, fragmentSrc: String): Int {
        val vsh = compileShader(GLES20.GL_VERTEX_SHADER, vertexSrc)
        val fsh = compileShader(GLES20.GL_FRAGMENT_SHADER, fragmentSrc)
        val program = GLES20.glCreateProgram()
        GLES20.glAttachShader(program, vsh)
        GLES20.glAttachShader(program, fsh)
        GLES20.glLinkProgram(program)
        val linked = IntArray(1)
        GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linked, 0)
        if (linked[0] == 0) {
            val log = GLES20.glGetProgramInfoLog(program)
            GLES20.glDeleteProgram(program)
            throw RuntimeException("Shader link failed: $log")
        }
        // Shaders can be detached + deleted once linked; the program
        // holds its own reference to the compiled object code.
        GLES20.glDetachShader(program, vsh)
        GLES20.glDetachShader(program, fsh)
        GLES20.glDeleteShader(vsh)
        GLES20.glDeleteShader(fsh)
        return program
    }

    private fun compileShader(type: Int, src: String): Int {
        val shader = GLES20.glCreateShader(type)
        GLES20.glShaderSource(shader, src)
        GLES20.glCompileShader(shader)
        val compiled = IntArray(1)
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0)
        if (compiled[0] == 0) {
            val log = GLES20.glGetShaderInfoLog(shader)
            GLES20.glDeleteShader(shader)
            throw RuntimeException("Shader compile failed: $log\nSource:\n$src")
        }
        return shader
    }

    /// Wrap a GLES call with `glGetError` checking — caller passes a
    /// human-readable label so the panic message tells you which call
    /// died.  Cheap; we only call it during init / per-frame setup.
    fun checkGLError(label: String) {
        val err = GLES20.glGetError()
        if (err != GLES20.GL_NO_ERROR) {
            throw RuntimeException("$label: glError 0x${err.toString(16)}")
        }
    }
}
