export type CdpNavigateAction = {
  type: 'navigate';
  path?: string;
};

export type CdpClickAction = {
  type: 'click';
  /** Tried in order until one matches. */
  selectors: string[];
};

export type CdpFillAction = {
  type: 'fill';
  selectors: string[];
  value: string;
};

export type CdpWaitForTextAction = {
  type: 'waitForText';
  text: string;
  timeoutMs?: number;
};

/** Wait until the page URL pathname includes this substring (e.g. `/done`). */
export type CdpWaitForPathAction = {
  type: 'waitForPath';
  pathIncludes: string;
  timeoutMs?: number;
};

export type CdpAction =
  | CdpNavigateAction
  | CdpClickAction
  | CdpFillAction
  | CdpWaitForTextAction
  | CdpWaitForPathAction;

export type CdpStepDefinition = {
  id: string;
  label: string;
  actions: CdpAction[];
};

export type CdpRunCallbacks = {
  onStep: (stepId: string, label: string) => void;
  onLog: (stepId: string, message: string) => void;
  onScreenshot: (stepId: string, url: string) => void;
  onComplete: (status: 'success' | 'fail') => void;
};

/** Mock plan — Atelier Canvas demo (Home → Login → Done → Browse category). */
export function demoCdpSteps(): CdpStepDefinition[] {
  return [
    {
      id: 'navigate-home',
      label: 'Navigate to home page',
      actions: [{ type: 'navigate', path: '/' }],
    },
    {
      id: 'click-get-started',
      label: 'Click "Get started"',
      actions: [
        {
          type: 'click',
          selectors: [
            '[data-testid="get-started"]',
            '[data-testid=get-started]',
            'button:has-text("Get started")',
            'a:has-text("Get started")',
            'text=Get started',
          ],
        },
      ],
    },
    {
      id: 'fill-credentials',
      label: 'Fill username and password',
      actions: [
        {
          type: 'fill',
          selectors: [
            '[data-testid="username"]',
            'input[name="username"]',
            '#username',
            'input[autocomplete="username"]',
          ],
          value: 'demo-user',
        },
        {
          type: 'fill',
          selectors: [
            '[data-testid="password"]',
            'input[name="password"]',
            '#password',
            'input[type="password"]',
          ],
          value: 'demo-pass',
        },
      ],
    },
    {
      id: 'submit-form',
      label: 'Submit login form',
      actions: [
        {
          type: 'click',
          selectors: [
            '[data-testid="submit"]',
            'button[type="submit"]',
            'button:has-text("Sign in")',
            'button:has-text("Log in")',
            'button:has-text("Continue")',
          ],
        },
      ],
    },
    {
      id: 'assert-done-hub',
      label: 'Confirm signed-in hub (/done)',
      actions: [
        {
          type: 'waitForPath',
          pathIncludes: '/done',
          timeoutMs: 15_000,
        },
      ],
    },
    {
      id: 'open-category',
      label: 'Open a gallery category',
      actions: [
        {
          type: 'click',
          selectors: [
            'a[href^="/browse/"]',
            '[data-testid="category-card"]',
            '[data-testid="category-card"] a',
          ],
        },
      ],
    },
    {
      id: 'assert-browse',
      label: 'Confirm category gallery (/browse/)',
      actions: [
        {
          type: 'waitForPath',
          pathIncludes: '/browse/',
          timeoutMs: 15_000,
        },
      ],
    },
  ];
}

export function describeAction(action: CdpAction, baseUrl: string): string {
  switch (action.type) {
    case 'navigate':
      return `Page.navigate → ${baseUrl}${action.path ?? '/'}`;
    case 'click':
      return `DOM.click ${action.selectors[0] ?? '?'}`;
    case 'fill':
      return `Input.fill ${action.selectors[0] ?? '?'} (mock value)`;
    case 'waitForText':
      return `Wait for text "${action.text}"`;
    case 'waitForPath':
      return `Wait for URL path containing "${action.pathIncludes}"`;
    default:
      return 'Unknown action';
  }
}
