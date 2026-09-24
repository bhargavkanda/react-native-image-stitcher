// @ts-check
// Explicit sidebar so ordering is intentional (not alphabetical).

/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docsSidebar: [
    'intro',
    'getting-started',
    'host-integration',
    {
      type: 'category',
      label: 'The <Camera> component',
      collapsed: false,
      items: [
        'camera-api',
        'full-example',
        'orientation',
        'flash-and-lenses',
        'photo-depth',
        'recipes',
        'dev-testing',
      ],
    },
    'capture-result',
    'i18n',
    {
      type: 'category',
      label: 'Native / OpenCV',
      collapsed: false,
      items: [
        'sharing-opencv',
        'bring-your-own-opencv',
        'android-abi-support',
      ],
    },
    'troubleshooting',
  ],
};

export default sidebars;
