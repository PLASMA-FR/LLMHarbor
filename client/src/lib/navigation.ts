import {
  Boxes,
  ChartNoAxesColumn,
  Code2,
  KeyRound,
  LayoutDashboard,
  MessageSquareCode,
  Route,
  Server,
  Settings2,
  ShieldCheck,
} from 'lucide-react'

export const navGroups = [
  {
    label: 'Workspace',
    items: [
      {
        to: '/overview',
        label: 'Overview',
        helper: 'Health, setup and recent activity',
        icon: LayoutDashboard,
      },
      {
        to: '/playground',
        label: 'Playground',
        helper: 'Test a prompt or tool call',
        icon: MessageSquareCode,
      },
    ],
  },
  {
    label: 'Configure',
    items: [
      { to: '/providers', label: 'Providers', helper: 'Upstream credentials and endpoints', icon: Server },
      { to: '/models', label: 'Models', helper: 'Catalog, probes and limits', icon: Boxes },
      { to: '/fallback', label: 'Routing', helper: 'Model priority and fallbacks', icon: Route },
      { to: '/oauth', label: 'OAuth accounts', helper: 'Browser account connections', icon: ShieldCheck },
    ],
  },
  {
    label: 'Operate',
    items: [
      {
        to: '/access',
        label: 'Client access',
        helper: 'App keys, quotas and access policies',
        icon: KeyRound,
      },
      {
        to: '/analytics',
        label: 'Analytics',
        helper: 'Traffic, errors and request traces',
        icon: ChartNoAxesColumn,
      },
      { to: '/api-guide', label: 'API & SDKs', helper: 'Integration examples and OpenAPI', icon: Code2 },
      { to: '/settings', label: 'Settings', helper: 'Discovery and backups', icon: Settings2 },
    ],
  },
]
export const navItems = navGroups.flatMap((group) => group.items)
