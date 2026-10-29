/**
 * The management-server field is shared by the login screen and settings, so its
 * contract is pinned here rather than twice through the screens: it submits
 * exactly what was typed, and only offers the way back to the default when the
 * address in force is actually the user's choice.
 *
 * @format
 */

import React from 'react';
import {Keyboard} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

jest.mock('../src/NetBirdPortal', () => ({
  NetBirdPortal: {
    getServerConfig: jest.fn(),
    setServerUrl: jest.fn(),
    resetServerUrl: jest.fn(),
  },
}));

import ServerAddressEditor from '../src/components/ServerAddressEditor';
import {NetBirdPortal} from '../src/NetBirdPortal';

const setServerUrlMock = NetBirdPortal.setServerUrl as jest.MockedFunction<
  typeof NetBirdPortal.setServerUrl
>;
const resetServerUrlMock = NetBirdPortal.resetServerUrl as jest.MockedFunction<
  typeof NetBirdPortal.resetServerUrl
>;

const DEFAULT_SERVER = {
  url: 'https://netbird.example.com:443',
  defaultUrl: 'https://netbird.example.com:443',
  isCustom: false,
};
const CUSTOM_SERVER = {
  url: 'https://nb.corp.example:8443',
  defaultUrl: 'https://netbird.example.com:443',
  isCustom: true,
};

async function renderEditor(
  config: typeof DEFAULT_SERVER,
  onSaved: (result: {url: string; changed: boolean}) => void = jest.fn(),
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <ServerAddressEditor config={config} onCancel={jest.fn()} onSaved={onSaved} />,
    );
  });
  return tree as unknown as ReactTestRenderer.ReactTestRenderer;
}

describe('server address editor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setServerUrlMock.mockResolvedValue({url: CUSTOM_SERVER.url, changed: true});
    resetServerUrlMock.mockResolvedValue({url: DEFAULT_SERVER.url, changed: true});
  });

  test('submits exactly what was typed', async () => {
    const tree = await renderEditor(DEFAULT_SERVER);

    await act(async () => {
      tree.root
        .findByProps({testID: 'server-editor-input'})
        .props.onChangeText('https://nb.corp.example:8443');
    });
    await act(async () => {
      await tree.root.findByProps({testID: 'server-editor-save'}).props.onPress();
    });

    expect(setServerUrlMock).toHaveBeenCalledWith('https://nb.corp.example:8443');
  });

  test('offers the way back to the default only when the address is a choice', async () => {
    const onDefault = await renderEditor(DEFAULT_SERVER);
    expect(onDefault.root.findAllByProps({testID: 'server-editor-reset'})).toHaveLength(0);

    const onCustom = await renderEditor(CUSTOM_SERVER);
    // `findAllByProps` counts the composed layers of one Pressable, so presence
    // is asserted through `findByProps` (which throws when there is none).
    expect(onCustom.root.findByProps({testID: 'server-editor-reset'})).toBeTruthy();
    // The reset names the address it would return to, so it is not a blind tap.
    expect(
      onCustom.root.findByProps({testID: 'server-editor-reset'}).props.accessibilityLabel,
    ).toContain('netbird.example.com');
    // https already implies 443: the row must not make the reader decode it.
    expect(
      onCustom.root.findByProps({testID: 'server-editor-reset'}).props.accessibilityLabel,
    ).not.toContain(':443');
  });

  test('says the old connection is being torn down while a save waits', async () => {
    let finish: ((result: {url: string; changed: boolean}) => void) | undefined;
    setServerUrlMock.mockImplementation(() => new Promise(resolve => (finish = resolve)));
    const tree = await renderEditor(DEFAULT_SERVER);

    let pressed: Promise<void> | undefined;
    await act(async () => {
      pressed = tree.root.findByProps({testID: 'server-editor-save'}).props.onPress();
      await Promise.resolve();
    });

    // Tearing down a connection that is mid-retry can take tens of seconds; the
    // field has to say what it is waiting for.
    expect(tree.root.findByProps({testID: 'server-editor-progress'})).toBeTruthy();

    await act(async () => {
      finish?.({url: CUSTOM_SERVER.url, changed: true});
      await pressed;
    });
  });

  test('reports a reset that ended the session', async () => {
    const onSaved = jest.fn();
    const tree = await renderEditor(CUSTOM_SERVER, onSaved);

    await act(async () => {
      await tree.root.findByProps({testID: 'server-editor-reset'}).props.onPress();
    });

    expect(resetServerUrlMock).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith({url: DEFAULT_SERVER.url, changed: true});
  });

  test('keeps the typed value and the reason when the address is refused', async () => {
    setServerUrlMock.mockRejectedValue(new Error('请输入以 https:// 开头的管理端地址'));
    const onSaved = jest.fn();
    const tree = await renderEditor(DEFAULT_SERVER, onSaved);

    await act(async () => {
      tree.root.findByProps({testID: 'server-editor-input'}).props.onChangeText('netbird.example');
    });
    await act(async () => {
      await tree.root.findByProps({testID: 'server-editor-save'}).props.onPress();
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(tree.root.findByProps({testID: 'server-editor-input'}).props.value).toBe(
      'netbird.example',
    );
    expect(tree.root.findByProps({testID: 'server-editor-error'}).props.children).toBe(
      '请输入以 https:// 开头的管理端地址',
    );
  });

  test('arrives selected, so replacing the address needs no manual erasure', async () => {
    const tree = await renderEditor(CUSTOM_SERVER);
    const input = tree.root.findByProps({testID: 'server-editor-input'});

    expect(input.props.value).toBe(CUSTOM_SERVER.url);
    // Measured on a device: the field arrives prefilled, so without this the
    // caret lands at the end of the old address and the next keystroke appends
    // to it, leaving backspace as the only way to replace it.
    expect(input.props.selectTextOnFocus).toBe(true);
  });

  test('clears the prefilled address in one press', async () => {
    const tree = await renderEditor(CUSTOM_SERVER);

    await act(async () => {
      tree.root.findByProps({testID: 'server-editor-clear'}).props.onPress();
    });

    expect(tree.root.findByProps({testID: 'server-editor-input'}).props.value).toBe('');
    // Nothing left to clear: the control must not linger as a dead target.
    expect(tree.root.findAllByProps({testID: 'server-editor-clear'})).toHaveLength(0);
  });

  test('drops the keyboard from the field, so the buttons come back in reach', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    const tree = await renderEditor(DEFAULT_SERVER);
    const input = tree.root.findByProps({testID: 'server-editor-input'});

    // The actions sit below the field and the keyboard covers them on a short
    // screen, so the IME action is the one gesture that puts them back.
    expect(input.props.returnKeyType).toBe('done');
    await act(async () => {
      input.props.onSubmitEditing();
    });

    expect(dismiss).toHaveBeenCalled();
    dismiss.mockRestore();
  });

  test('probes the typed address over the device network, before it is saved', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn(async () => ({status: 200}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const tree = await renderEditor(DEFAULT_SERVER);

      await act(async () => {
        await tree.root.findByProps({testID: 'server-editor-test'}).props.onPress();
      });

      // Not through the netstack: before enrollment there is nothing to route,
      // and the address is usually a public name the tunnel cannot resolve.
      expect(fetchMock).toHaveBeenCalledWith('https://netbird.example.com/api/peers');
      expect(tree.root.findByProps({testID: 'server-editor-verdict'}).props.children).toContain(
        '可连接',
      );
      expect(setServerUrlMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('says what is wrong when nothing answers', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => {
      throw new Error('Network request failed');
    }) as unknown as typeof fetch;
    try {
      const tree = await renderEditor(DEFAULT_SERVER);

      await act(async () => {
        await tree.root.findByProps({testID: 'server-editor-test'}).props.onPress();
      });

      expect(tree.root.findByProps({testID: 'server-editor-verdict'}).props.children).toContain(
        '连不上',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('drops a verdict that belongs to an address the reader has left', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn(async () => ({status: 200})) as unknown as typeof fetch;
    try {
      const tree = await renderEditor(DEFAULT_SERVER);
      await act(async () => {
        await tree.root.findByProps({testID: 'server-editor-test'}).props.onPress();
      });
      expect(tree.root.findByProps({testID: 'server-editor-verdict'})).toBeTruthy();

      await act(async () => {
        tree.root
          .findByProps({testID: 'server-editor-input'})
          .props.onChangeText('https://other.example');
      });

      // A verdict describes the address it was measured against; keeping it after
      // an edit would vouch for something the reader never tested.
      expect(tree.root.findAllByProps({testID: 'server-editor-verdict'})).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});