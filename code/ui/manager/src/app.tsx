import React, { useMemo } from 'react';
import { useResizeDetector } from 'react-resize-detector';

import { type State } from '@storybook/manager-api';
import { Symbols } from '@storybook/components';
import { Global, createGlobal, styled } from '@storybook/theming';

import type { Addon_PageType } from '@storybook/types';
import { Mobile } from './components/layout/mobile';
import { Desktop } from './components/layout/desktop';
import Sidebar from './containers/sidebar';
import Preview from './containers/preview';
import Panel from './containers/panel';
import Notifications from './containers/notifications';
import { Layout } from './components/layoutNew/Layout';

const View = styled.div({
  position: 'fixed',
  overflow: 'hidden',
  height: '100vh',
  width: '100vw',
});

export interface AppProps {
  viewMode: State['viewMode'];
  layout: State['layout'];
  panelCount: number;
  pages: Addon_PageType[];
  newLayout?: boolean;
}

const App: React.FC<AppProps> = ({ viewMode, layout, panelCount, pages, newLayout = false }) => {
  const { width, height, ref } = useResizeDetector();
  const isReady = !!width && !!height;
  const isMobile = isReady ? width < 600 : null;
  const isDesktop = isReady ? width >= 600 : null;

  const props = useMemo(
    () => ({
      Sidebar,
      Preview,
      Panel,
      Notifications,
    }),
    []
  );

  return (
    <View ref={ref}>
      <Global styles={createGlobal} />
      <Symbols icons={['folder', 'component', 'document', 'bookmarkhollow']} />
      {!newLayout && (
        <>
          {isMobile && <Mobile {...props} viewMode={viewMode} options={layout} pages={pages} />}
          {isDesktop && (
            <Desktop
              {...props}
              viewMode={viewMode}
              options={layout}
              width={width}
              height={height}
              panelCount={panelCount}
              pages={pages}
            />
          )}
        </>
      )}
      {newLayout && <Layout />}
    </View>
  );
};

App.displayName = 'App';

export default App;
