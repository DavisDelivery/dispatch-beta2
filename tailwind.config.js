/** @type {import('tailwindcss').Config} */
export default {
  // Dark is the default; `.light` on <html> opts into the light theme.
  darkMode: ['class', '.light'],
  // Preflight OFF so Tailwind coexists with the legacy index.css during the
  // incremental reskin. New surfaces use the token-driven utilities below.
  corePlugins: { preflight: false },
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        background: 'hsl(var(--background) / <alpha-value>)',
        'background-subtle': 'hsl(var(--background-subtle) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        card: 'hsl(var(--card) / <alpha-value>)',
        'card-hover': 'hsl(var(--card-hover) / <alpha-value>)',
        popover: 'hsl(var(--popover) / <alpha-value>)',
        muted: 'hsl(var(--muted) / <alpha-value>)',
        'muted-foreground': 'hsl(var(--muted-foreground) / <alpha-value>)',
        accent: 'hsl(var(--accent) / <alpha-value>)',
        'accent-foreground': 'hsl(var(--accent-foreground) / <alpha-value>)',
        primary: 'hsl(var(--primary) / <alpha-value>)',
        'primary-foreground': 'hsl(var(--primary-foreground) / <alpha-value>)',
        border: 'hsl(var(--border) / <alpha-value>)',
        'border-strong': 'hsl(var(--border-strong) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        destructive: 'hsl(var(--destructive) / <alpha-value>)',
        success: 'hsl(var(--success) / <alpha-value>)',
        warning: 'hsl(var(--warning) / <alpha-value>)',
        info: 'hsl(var(--info) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['InterVariable', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.25rem',
      },
      boxShadow: {
        soft: '0 1px 2px 0 hsl(220 40% 2% / 0.4), 0 1px 3px 0 hsl(220 40% 2% / 0.3)',
        pop: '0 10px 30px -10px hsl(220 40% 2% / 0.55), 0 4px 12px -4px hsl(220 40% 2% / 0.4)',
        ring: '0 0 0 1px hsl(var(--border) / 1)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': { from: { opacity: '0', transform: 'scale(0.97)' }, to: { opacity: '1', transform: 'scale(1)' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out',
        'scale-in': 'scale-in 0.13s cubic-bezier(0.16,1,0.3,1)',
        'slide-up': 'slide-up 0.2s cubic-bezier(0.16,1,0.3,1)',
      },
    },
  },
  plugins: [],
}
