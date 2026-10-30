import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { 950: '#07182d', 900: '#0b2340', 800: '#12375d' },
        teal: { 50: '#effcfb', 100: '#d7f7f3', 500: '#14a79a', 600: '#0d887e', 700: '#0b6e67' }
      },
      boxShadow: { card: '0 18px 50px -30px rgba(7, 24, 45, .35)' }
    }
  },
  plugins: []
} satisfies Config;
