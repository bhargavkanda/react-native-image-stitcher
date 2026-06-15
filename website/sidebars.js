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
      items: ['camera-api', 'orientation', 'flash-and-lenses', 'recipes'],
    },
    'capture-result',
    'i18n',
    'troubleshooting',
  ],
};

export default sidebars;
