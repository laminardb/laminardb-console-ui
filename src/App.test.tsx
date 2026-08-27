// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('./api', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api')>();
  return {
    ...original,
    api: {
      ...original.api,
      probeConnection: vi.fn().mockRejectedValue(new Error('server unavailable')),
    },
    getConnectionConfig: () => ({ baseUrl: 'http://localhost:8080', token: '' }),
    saveConnectionConfig: (baseUrl: string, token: string) => ({ baseUrl, token }),
  };
});

import App from './App';

afterEach(cleanup);

describe('application shell', () => {
  it('keeps connection failure actionable and passes an automated accessibility scan', async () => {
    const { container } = render(<App />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('server unavailable'));
    expect(screen.getByRole('heading', { name: 'LaminarDB Console' })).toBeInTheDocument();
    expect(screen.getByLabelText('LaminarDB API URL')).toHaveValue('http://localhost:8080');
    expect(screen.getByRole('button', { name: 'Overview' })).toBeDisabled();
    expect(screen.getByText(/f905741c/)).toBeInTheDocument();

    // jsdom has no canvas implementation, so contrast is verified from the
    // design tokens while the remaining axe rules run here.
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
