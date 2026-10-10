import { describe, expect, it } from 'vitest'

import { selectCover } from '../user-infobox/cover'

const info = (title: string, mime: string, width: number, height: number) => ({
  title,
  imageinfo: [
    {
      mime,
      width,
      height,
      url: `https://img/${title}`,
      thumburl: `https://thumb/${title}`,
    },
  ],
})

describe('selectCover', () => {
  it('keeps page order, not the order the query returns pages in', () => {
    const query = {
      pages: [
        info('File:B.jpg', 'image/jpeg', 800, 600),
        info('File:A.jpg', 'image/jpeg', 800, 600),
      ],
    }
    expect(selectCover(['A.jpg', 'B.jpg'], query)).toBe(
      'https://thumb/File:A.jpg'
    )
  })

  it('skips svg icons and images whose short side is under 300px', () => {
    const query = {
      pages: [
        info('File:Icon.svg', 'image/svg+xml', 512, 512),
        info('File:Small.png', 'image/png', 256, 256),
        info('File:Wide banner.png', 'image/png', 1200, 200),
        info('File:Art.png', 'image/png', 500, 700),
      ],
    }
    expect(
      selectCover(
        ['Icon.svg', 'Small.png', 'Wide_banner.png', 'Art.png'],
        query
      )
    ).toBe('https://thumb/File:Art.png')
  })

  it('resolves names through normalized titles (underscores, localized namespace)', () => {
    const query = {
      normalized: [{ from: 'File:My_art.jpg', to: '文件:My art.jpg' }],
      pages: [info('文件:My art.jpg', 'image/jpeg', 800, 600)],
    }
    expect(selectCover(['My_art.jpg'], query)).toBe(
      'https://thumb/文件:My art.jpg'
    )
  })

  it('returns undefined when nothing qualifies', () => {
    const query = { pages: [info('File:Icon.svg', 'image/svg+xml', 512, 512)] }
    expect(selectCover(['Icon.svg'], query)).toBeUndefined()
  })
})
