import type { Preview } from '@storybook/sveltekit';
import '../src/lib/styles.css';
import ThemeDecorator from './ThemeDecorator.svelte';

const preview: Preview = {
  parameters: {
    options: {
      storySort: { method: 'alphabetical' }
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i
      }
    },
    backgrounds: {
      default: 'kb2-bg',
      values: [
        { name: 'kb2-bg', value: '#f1f2f4' },
        { name: 'panel', value: '#ffffff' },
        { name: 'dark', value: '#0e1014' }
      ]
    },
    viewport: {
      options: {
        mobile: { name: 'Mobile (375x812)', styles: { width: '375px', height: '812px' }, type: 'mobile' },
        tablet: { name: 'Tablet (768x1024)', styles: { width: '768px', height: '1024px' }, type: 'tablet' },
        desktop: { name: 'Desktop (1280x800)', styles: { width: '1280px', height: '800px' }, type: 'desktop' },
        wide: { name: 'Wide (1440x900)', styles: { width: '1440px', height: '900px' }, type: 'desktop' }
      }
    }
  },
  decorators: [
    (_storyFn, context) => ({
      Component: ThemeDecorator,
      props: { mode: context.globals.colorMode ?? 'light' }
    })
  ],
  globalTypes: {
    colorMode: {
      description: 'Color mode',
      defaultValue: 'light',
      toolbar: {
        title: 'Color',
        icon: 'sun',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
          { value: 'side-by-side', title: 'Side-by-side', icon: 'sidebyside' }
        ],
        dynamicTitle: true
      }
    }
  }
};

export default preview;
