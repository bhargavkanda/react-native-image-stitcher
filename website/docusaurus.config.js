// @ts-check
// Docusaurus config for the react-native-image-stitcher docs site.
// Deployed to GitHub Pages at https://bhargavkanda.github.io/react-native-image-stitcher/

import { themes as prismThemes } from 'prism-react-renderer';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'react-native-image-stitcher',
  tagline: 'Pose-aware panorama capture + stitching for React Native (iOS + Android)',
  favicon: 'img/favicon.ico',

  url: 'https://bhargavkanda.github.io',
  baseUrl: '/react-native-image-stitcher/',

  organizationName: 'bhargavkanda',
  projectName: 'react-native-image-stitcher',
  trailingSlash: false,

  onBrokenLinks: 'warn',

  // v3.6+: markdown link-check moved under markdown.hooks.
  markdown: { hooks: { onBrokenMarkdownLinks: 'warn' } },

  i18n: { defaultLocale: 'en', locales: ['en'] },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          routeBasePath: 'docs',
          editUrl:
            'https://github.com/bhargavkanda/react-native-image-stitcher/tree/main/website/',
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      colorMode: { defaultMode: 'dark', respectPrefersColorScheme: true },
      navbar: {
        title: 'react-native-image-stitcher',
        items: [
          { type: 'docSidebar', sidebarId: 'docsSidebar', position: 'left', label: 'Docs' },
          {
            href: 'https://www.npmjs.com/package/react-native-image-stitcher',
            label: 'npm',
            position: 'right',
          },
          {
            href: 'https://github.com/bhargavkanda/react-native-image-stitcher',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Getting started', to: '/docs/getting-started' },
              { label: '<Camera> API', to: '/docs/camera-api' },
              { label: 'Orientation', to: '/docs/orientation' },
            ],
          },
          {
            title: 'More',
            items: [
              { label: 'npm', href: 'https://www.npmjs.com/package/react-native-image-stitcher' },
              { label: 'GitHub', href: 'https://github.com/bhargavkanda/react-native-image-stitcher' },
            ],
          },
        ],
        copyright: `Copyright © ${'2026'} Bhargava Ram Kanda. Apache-2.0.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'json', 'tsx', 'kotlin', 'swift'],
      },
    }),
};

export default config;
