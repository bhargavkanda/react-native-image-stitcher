// SPDX-License-Identifier: Apache-2.0
import { shouldOfferNativeUltraWide } from '../nativeUltraWide';

const base = {
  hasInAppUltraWide: false,
  platformOS: 'android',
  deviceModel: 'SM-A346B',
  deviceManufacturer: 'samsung',
  models: ['SM-A346'],
} as const;

describe('shouldOfferNativeUltraWide', () => {
  it('offers when android + no in-app UW + model prefix matches', () => {
    expect(shouldOfferNativeUltraWide({ ...base })).toBe(true);
  });

  it('prefix entry covers all SKUs of a model family', () => {
    expect(
      shouldOfferNativeUltraWide({ ...base, deviceModel: 'SM-A346E' }),
    ).toBe(true);
    expect(
      shouldOfferNativeUltraWide({ ...base, deviceModel: 'SM-A346U1' }),
    ).toBe(true);
  });

  it('does NOT offer when the device has an in-app ultra-wide', () => {
    expect(
      shouldOfferNativeUltraWide({ ...base, hasInAppUltraWide: true }),
    ).toBe(false);
  });

  it('never offers on iOS', () => {
    expect(shouldOfferNativeUltraWide({ ...base, platformOS: 'ios' })).toBe(
      false,
    );
  });

  it('off when the list is absent or empty (default OFF)', () => {
    expect(
      shouldOfferNativeUltraWide({ ...base, models: undefined }),
    ).toBe(false);
    expect(shouldOfferNativeUltraWide({ ...base, models: [] })).toBe(false);
  });

  it('does not match a different model', () => {
    expect(
      shouldOfferNativeUltraWide({ ...base, deviceModel: 'SM-S938B' }),
    ).toBe(false);
  });

  it('is case-insensitive on model + entry', () => {
    expect(
      shouldOfferNativeUltraWide({
        ...base,
        deviceModel: 'sm-a346b',
        models: ['SM-A346'],
      }),
    ).toBe(true);
  });

  it('manufacturer:<brand> wildcard matches by manufacturer', () => {
    expect(
      shouldOfferNativeUltraWide({
        ...base,
        deviceModel: 'SM-XYZ999',
        models: ['manufacturer:samsung'],
      }),
    ).toBe(true);
    expect(
      shouldOfferNativeUltraWide({
        ...base,
        deviceManufacturer: 'google',
        models: ['manufacturer:samsung'],
      }),
    ).toBe(false);
  });

  it('safe with undefined model/manufacturer (no crash, no match)', () => {
    expect(
      shouldOfferNativeUltraWide({
        ...base,
        deviceModel: undefined,
        deviceManufacturer: undefined,
      }),
    ).toBe(false);
  });

  it('an empty-string list entry never matches', () => {
    expect(shouldOfferNativeUltraWide({ ...base, models: [''] })).toBe(false);
  });

  it('trims whitespace around a list entry', () => {
    expect(
      shouldOfferNativeUltraWide({ ...base, models: ['  SM-A346  '] }),
    ).toBe(true);
  });

  it('trims whitespace around the device MODEL value (padded Build.MODEL)', () => {
    expect(
      shouldOfferNativeUltraWide({ ...base, deviceModel: '  SM-A346B  ' }),
    ).toBe(true);
  });

  it('trims whitespace around the device MANUFACTURER value', () => {
    expect(
      shouldOfferNativeUltraWide({
        ...base,
        deviceModel: 'SM-XYZ999',
        deviceManufacturer: '  samsung  ',
        models: ['manufacturer:samsung'],
      }),
    ).toBe(true);
  });

  it('a bare "manufacturer:" wildcard (no brand) never matches', () => {
    expect(
      shouldOfferNativeUltraWide({ ...base, models: ['manufacturer:'] }),
    ).toBe(false);
  });

  it('the android platform gate wins even when the model matches', () => {
    // A matching model on iOS must still be refused (iOS reaches the UW).
    expect(
      shouldOfferNativeUltraWide({
        ...base,
        platformOS: 'ios',
        deviceModel: 'SM-A346B',
        models: ['SM-A346'],
      }),
    ).toBe(false);
  });
});
