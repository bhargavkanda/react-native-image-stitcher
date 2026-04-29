/**
 * Configuration for the capture SDK.
 */
export interface CaptureSDKConfig {
  /** Maximum photo resolution (width in pixels) */
  maxResolution: number;
  /** JPEG compression quality (0-100) */
  compressionQuality: number;
  /** Minimum number of captures required per audit */
  minCaptures: number;
  /** Maximum number of captures allowed per audit */
  maxCaptures: number;
  /** Whether to enable video recording mode */
  enableVideo: boolean;
  /** Maximum video duration in seconds */
  maxVideoDurationSeconds: number;
  /** Whether to enable quality checks (blur, brightness) */
  enableQualityChecks: boolean;
  /** Quality check thresholds */
  qualityThresholds: QualityThresholds;
  /** Theme configuration for branded overlays */
  theme?: CaptureThemeConfig;
}

export interface QualityThresholds {
  /** Minimum Laplacian variance for blur detection */
  minBlurScore: number;
  /** Minimum brightness (0-255) */
  minBrightness: number;
  /** Maximum brightness (0-255) */
  maxBrightness: number;
}

export interface CaptureThemeConfig {
  primaryColor: string;
  guidanceTextColor: string;
  guidanceBackgroundColor: string;
  buttonColor: string;
}

/**
 * Result from a capture operation.
 */
export interface CaptureResult {
  /** Unique device-generated UUID */
  deviceUuid: string;
  /** Local file path to compressed image */
  compressedUri: string;
  /** Local file path to original image (if retained) */
  originalUri?: string;
  /**
   * Image width in pixels, after EXIF orientation correction.
   * Always populated for tap-photos (from vision-camera) and for
   * stitched panoramas (from the OpenCV result).  Used by the
   * SDK's thumbnail/preview components to render at the correct
   * aspect ratio instead of forcing a square crop.
   */
  width: number;
  /** Image height in pixels, after EXIF orientation correction. */
  height: number;
  /** Whether this is a stitched panoramic image */
  isStitched: boolean;
  /** Capture timestamp (ISO 8601) */
  capturedAt: string;
  /** Quality check results (if enabled) */
  qualityReport?: QualityReport;
  /** Device metadata at capture time */
  deviceMetadata: DeviceMetadata;
}

export interface QualityReport {
  passed: boolean;
  blurScore: number;
  brightnessScore: number;
  issues: QualityIssue[];
}

export interface QualityIssue {
  type: 'blur' | 'brightness_low' | 'brightness_high' | 'framing';
  message: string;
  severity: 'warning' | 'error';
}

export interface DeviceMetadata {
  platform: 'ios' | 'android';
  osVersion: string;
  deviceModel: string;
  cameraId: string;
  flashEnabled: boolean;
}

/**
 * The main SDK interface. Implementations will be provided in Module 11.
 */
export interface ICaptureSDK {
  /** Initialize the SDK with configuration */
  initialize(config: CaptureSDKConfig): Promise<void>;
  /** Check if camera permissions are granted */
  hasPermissions(): Promise<boolean>;
  /** Request camera permissions */
  requestPermissions(): Promise<boolean>;
  /** Capture a single photo */
  capturePhoto(): Promise<CaptureResult>;
  /** Start video recording */
  startVideoRecording(): Promise<void>;
  /** Stop video recording and return stitched result */
  stopVideoRecording(): Promise<CaptureResult>;
  /** Run quality check on an existing image */
  checkQuality(imageUri: string): Promise<QualityReport>;
  /** Get current SDK version */
  getVersion(): string;
  /** Dispose and clean up resources */
  dispose(): Promise<void>;
}
