import React from 'react';
import { Redirect } from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';

// The site is docs-first; send the root straight to the intro page.
export default function Home() {
  return <Redirect to={useBaseUrl('/docs/intro')} />;
}
