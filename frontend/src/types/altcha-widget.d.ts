// The captcha widget is a web component; this teaches JSX its tag and attributes.

import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'altcha-widget': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        challenge?: string
        name?: string
      }
    }
  }
}
