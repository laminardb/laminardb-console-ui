// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ConfirmDialog from './ConfirmDialog';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  it('labels the alert dialog, focuses the safe action, handles Escape, and restores focus', () => {
    const onCancel = vi.fn();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(
      <ConfirmDialog
        open
        title="Suspend pipeline?"
        description="Processing will stop."
        confirmLabel="Suspend"
        danger
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole('alertdialog', { name: 'Suspend pipeline?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(
      <ConfirmDialog
        open={false}
        title="Suspend pipeline?"
        description="Processing will stop."
        confirmLabel="Suspend"
        danger
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('has no automatically detectable accessibility violations', async () => {
    const { container } = render(
      <ConfirmDialog
        open
        title="Drop relation?"
        description="This cannot be undone."
        confirmLabel="Drop"
        danger
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    // jsdom has no canvas implementation, so contrast is verified from the
    // design tokens while the remaining axe rules run here.
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
