/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Primary: deep sage green — literary, grounded, warm
        sage: {
          50: '#f6f7f4',
          100: '#e8ebe3',
          200: '#d3d9c9',
          300: '#b4bfa4',
          400: '#95a37f',
          500: '#758760',
          600: '#5c6b4c',
          700: '#48543d',
          800: '#3b4533',
          900: '#333b2d',
          950: '#1a1f16',
        },
        // Accent: warm amber — energy, creativity, highlights
        amber: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
          900: '#78350f',
        },
        // Neutral: warm grays with slight brown undertone
        warm: {
          50: '#faf9f7',
          100: '#f5f3f0',
          200: '#e8e4df',
          300: '#d6d0c8',
          400: '#b8b0a4',
          500: '#9c9284',
          600: '#847869',
          700: '#6b6155',
          800: '#5a5148',
          900: '#4d453e',
          950: '#292420',
        },
        // Ink: for text — deep warm black
        ink: {
          DEFAULT: '#2c2825',
          light: '#4a4440',
          muted: '#7a7268',
        },
        // Cream: page background
        cream: '#fdfcfa',
      },
      fontFamily: {
        serif: ['Lora', 'Georgia', 'Cambria', 'Times New Roman', 'serif'],
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      fontSize: {
        'coaching': ['1.0625rem', { lineHeight: '1.75' }], // 17px — comfortable reading
      },
    },
  },
  plugins: [],
};
