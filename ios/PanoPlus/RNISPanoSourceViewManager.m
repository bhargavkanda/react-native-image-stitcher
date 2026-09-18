// SPDX-License-Identifier: Apache-2.0
//
// RNISPanoSourceViewManager.m
//
// RN bridge declaration for the Swift `RNISPanoSourceViewManager` (see
// RNISPanoSourceView.swift).  Without this file the JS side's
// `requireNativeComponent('RNSSweepSourceView')` resolves to nothing: RN's
// component registry is populated by RCT_EXTERN_MODULE, not by Swift @objc
// decorators alone.  RN derives the JS-visible component name by stripping
// the trailing "Manager" — so this registers "RNSSweepSourceView", which is
// the name a host probes for via `UIManager.getViewManagerConfig` before
// calling `requireNativeComponent`.
//
// No props: the view is a pure output surface.  Session lifecycle rides the
// module methods (`start` / `stop` / `setIdlePreview`), never the view.

#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(RNSSweepSourceViewManager, RCTViewManager)
@end
