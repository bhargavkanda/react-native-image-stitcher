// SPDX-License-Identifier: Apache-2.0
/**
 * packStatus.ts — the HOST-OWNED debug-pack save status, as the review screens
 * consume it (2026-08-10: "show the status of the debug pack — save, saving,
 * saved… persist even when I open the preview later from thumbnails").
 *
 * The SDK stays filesystem-agnostic (the `reviewDebugActions` contract): it
 * neither builds packs nor stores their status. What the review screens need
 * is a READ — "for the result I am showing, what is its pack's state right
 * now?" — that keeps working when the same result is re-opened from a session
 * thumbnail, which is why the accessor takes the RESULT rather than any id:
 * the result object is the one identity every review path holds.
 *
 * RN-free on purpose (the `sessionThumbs.ts` split): the label formatter is
 * the decision-carrying part — which states render, what a size reads as,
 * that 'failed' must offer a retry — and this module keeps it testable in the
 * pure jest project.
 */

/** One capture's pack status, as the host's store answers it. */
export interface PackStatusSnapshot {
  /**
   * 'stalled' (2026-09-02) means the save crossed its deadline without an
   * outcome — added after a Galaxy A35 Mosaic pack sat in 'saving' with a null
   * error for hours, because a wedged native-modules queue meant its zip
   * Promise never settled. It renders DISTINCTLY from 'failed' on purpose: a
   * failed save is over, a stalled one may still land, and the operator's next
   * move differs (retry now vs. the app is not frozen, the save is stuck).
   */
  state: 'saving' | 'saved' | 'failed' | 'stalled';
  /** Zip size in bytes for 'saved' — the storage-management number the
   *  operator asked to see. Null/absent = unknown. */
  sizeBytes?: number | null;
  /** Failure copy for 'failed'. */
  error?: string | null;
}

/**
 * The host's status surface, ridden by `reviewDebugActions.packStatus`.
 *
 * `get` MUST return a REFERENCE-STABLE snapshot (the same object until the
 * status actually changes): the screens read it through
 * `useSyncExternalStore`, and a fresh object per call would render-loop. A
 * store that keeps one entry object per capture (replaced on transition)
 * satisfies this for free.
 */
export interface PackStatusProvider {
  /** Snapshot for the result under review; null = no record (no pack has ever
   *  been queued for this capture). */
  get: (result: unknown) => PackStatusSnapshot | null;
  /** Subscribe to ANY status change; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

/** `12.3 MB` / `842 KB` / `120 B` — one decimal above KB, whole below. */
export function formatPackSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return '?';
  if (sizeBytes >= 1024 * 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (sizeBytes >= 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${sizeBytes} B`;
}

/** What the status pill renders, and whether tapping it retries the save. */
export interface PackStatusLabel {
  text: string;
  /** True only for 'failed' — the pill becomes the tap-to-retry affordance. */
  retry: boolean;
}

/**
 * Snapshot → pill. Null in, null out (no record ⇒ no pill — the manual Save
 * button alone renders, exactly the pre-feature row).
 *
 *   saving  → "⏳ Pack saving…"          (also the queued state — to the
 *                                         operator a queued pack IS saving)
 *   saved   → "✓ Pack 12.3 MB"          (size is the ask; absent size still
 *                                         confirms the save)
 *   stalled → "⌛ Pack stuck — retry"    (tappable; the deadline passed with
 *                                         no outcome — see PackStatusSnapshot)
 *   failed  → "⚠ Pack failed — retry"   (tappable; the error's full copy
 *                                         rides the host's own alert/log)
 */
export function packStatusLabel(
  s: PackStatusSnapshot | null,
): PackStatusLabel | null {
  if (s == null) return null;
  if (s.state === 'saving') return { text: '⏳ Pack saving…', retry: false };
  // Named before the 'failed' fallthrough below, so a stall reads as a stall.
  // Retryable: the operator's one useful action on a stuck save is to re-run it.
  if (s.state === 'stalled') return { text: '⌛ Pack stuck — retry', retry: true };
  if (s.state === 'saved') {
    return {
      text:
        s.sizeBytes != null
          ? `✓ Pack ${formatPackSize(s.sizeBytes)}`
          : '✓ Pack saved',
      retry: false,
    };
  }
  return { text: '⚠ Pack failed — retry', retry: true };
}
