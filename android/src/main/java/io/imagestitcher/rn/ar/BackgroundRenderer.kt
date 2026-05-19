// SPDX-License-Identifier: UNLICENSED
package io.imagestitcher.rn.ar

import android.opengl.GLES11Ext
import android.opengl.GLES20
import com.google.ar.core.Coordinates2d
import com.google.ar.core.Frame
import com.google.ar.core.Session
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

/**
 * Renders the ARCore camera feed as a fullscreen background quad.
 *
 * ARCore delivers camera frames via a GL_TEXTURE_EXTERNAL_OES texture
 * (the OpenGL ES extension that lets a SurfaceTexture be sampled
 * directly).  We bind that texture to the session via
 * `Session.setCameraTextureName()` and render it through the
 * fullscreen quad below; ARCore handles the camera pixel updates
 * inside `Session.update()`.
 *
 * Why hand-rolled vs adopting the Google hello_ar sample:
 *   The sample is ~250 lines per renderer plus shader files in
 *   `assets/shaders/`.  We only need a fullscreen quad — vertex
 *   coords (-1..1) plus texture coords supplied by ARCore via
 *   `Frame.transformCoordinates2d()`.  That fits in ~150 lines
 *   inline, no asset dependency, easier to debug.
 */
internal class BackgroundRenderer {

    /// OES texture id ARCore writes camera pixels into.
    var textureId: Int = -1
        private set

    /// Compiled shader program.
    private var program: Int = 0
    /// Attribute / uniform locations cached at link time.
    private var positionAttrib: Int = 0
    private var texCoordAttrib: Int = 0
    private var textureUniform: Int = 0

    /// Static fullscreen quad coords.
    private val quadCoords: FloatBuffer = ByteBuffer
        .allocateDirect(QUAD_COORDS.size * 4)
        .order(ByteOrder.nativeOrder())
        .asFloatBuffer()
        .apply {
            put(QUAD_COORDS)
            position(0)
        }

    /// Texture coords ARCore overwrites each frame via
    /// `Frame.transformCoordinates2d()`.  The buffer is allocated
    /// once and refilled in-place to avoid GC pressure.
    private val quadTexCoords: FloatBuffer = ByteBuffer
        .allocateDirect(QUAD_COORDS.size * 4)
        .order(ByteOrder.nativeOrder())
        .asFloatBuffer()

    /// Has `Session.setCameraTextureName()` been called for the
    /// current GL context?  `BackgroundRenderer` is created on the
    /// GL render thread but the Session may already exist; we
    /// connect them on the first draw call.
    private var sessionTextureBound: Boolean = false

    fun createOnGlThread() {
        // Create OES texture for ARCore's camera output.
        val textures = IntArray(1)
        GLES20.glGenTextures(1, textures, 0)
        textureId = textures[0]
        val target = GLES11Ext.GL_TEXTURE_EXTERNAL_OES
        GLES20.glBindTexture(target, textureId)
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)

        program = ShaderUtil.loadGLProgram(VERTEX_SHADER, FRAGMENT_SHADER)
        positionAttrib = GLES20.glGetAttribLocation(program, "a_Position")
        texCoordAttrib = GLES20.glGetAttribLocation(program, "a_TexCoord")
        textureUniform = GLES20.glGetUniformLocation(program, "sTexture")
        ShaderUtil.checkGLError("BackgroundRenderer.createOnGlThread")
    }

    fun bindToSession(session: Session) {
        if (textureId == -1) return
        session.setCameraTextureName(textureId)
        sessionTextureBound = true
    }

    /// Draw the camera feed for the given ARFrame.  Must be called
    /// from `Renderer.onDrawFrame` after `Session.update()`.  No-op
    /// if the GL program isn't ready yet (very first frame).
    fun draw(frame: Frame) {
        if (program == 0) return
        // Update the tex coords from the ARFrame whenever the display
        // geometry has changed (rotation, surface resize).  Cheap
        // (constant 8 floats) so we do it every frame.
        if (frame.hasDisplayGeometryChanged()) {
            frame.transformCoordinates2d(
                Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES,
                quadCoords,
                Coordinates2d.TEXTURE_NORMALIZED,
                quadTexCoords,
            )
        }
        // First frame after onSurfaceCreated: do an unconditional fill
        // so we have valid tex coords before geometryChanged ever flips.
        if (quadTexCoords.position() == 0 && !frame.hasDisplayGeometryChanged()) {
            frame.transformCoordinates2d(
                Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES,
                quadCoords,
                Coordinates2d.TEXTURE_NORMALIZED,
                quadTexCoords,
            )
        }
        quadCoords.position(0)
        quadTexCoords.position(0)

        GLES20.glDisable(GLES20.GL_DEPTH_TEST)
        GLES20.glDepthMask(false)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId)
        GLES20.glUseProgram(program)
        GLES20.glUniform1i(textureUniform, 0)

        GLES20.glVertexAttribPointer(positionAttrib, 2, GLES20.GL_FLOAT, false, 0, quadCoords)
        GLES20.glEnableVertexAttribArray(positionAttrib)
        GLES20.glVertexAttribPointer(texCoordAttrib, 2, GLES20.GL_FLOAT, false, 0, quadTexCoords)
        GLES20.glEnableVertexAttribArray(texCoordAttrib)

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)

        GLES20.glDisableVertexAttribArray(positionAttrib)
        GLES20.glDisableVertexAttribArray(texCoordAttrib)
        GLES20.glDepthMask(true)
        GLES20.glEnable(GLES20.GL_DEPTH_TEST)
        ShaderUtil.checkGLError("BackgroundRenderer.draw")
    }

    companion object {
        // Fullscreen quad in NDC space.  4 vertices, GL_TRIANGLE_STRIP
        // order: bottom-left, bottom-right, top-left, top-right.
        private val QUAD_COORDS = floatArrayOf(
            -1f, -1f,
             1f, -1f,
            -1f,  1f,
             1f,  1f,
        )

        // Vertex shader: pass-through.  Tex coords are pre-transformed
        // into TEXTURE_NORMALIZED space by ARCore so no extra matrix
        // math is needed.
        private val VERTEX_SHADER = """
            attribute vec4 a_Position;
            attribute vec2 a_TexCoord;
            varying vec2 v_TexCoord;
            void main() {
                gl_Position = a_Position;
                v_TexCoord = a_TexCoord;
            }
        """.trimIndent()

        // Fragment shader: sample the OES external texture and write.
        private val FRAGMENT_SHADER = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            uniform samplerExternalOES sTexture;
            varying vec2 v_TexCoord;
            void main() {
                gl_FragColor = texture2D(sTexture, v_TexCoord);
            }
        """.trimIndent()
    }
}
