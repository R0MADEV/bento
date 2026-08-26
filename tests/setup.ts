import { beforeEach, vi } from 'vitest'
import { makeLocalStorage } from './helpers/localStorage'

// Cada fichero de test corre en el mismo worker que otros, y varios cambian el
// `localStorage` global. Sin esto, el idioma con el que se pinta un panel
// dependía de qué fichero hubiera corrido antes: en local salía español y en CI
// inglés, y los tests que buscan un botón por su texto fallaban solo allí.
//
// El idioma se fija antes de cada test. Un test que necesite otro solo tiene que
// escribirlo encima, como ya hacen los que comprueban la traducción.
beforeEach(() => {
  vi.stubGlobal('localStorage', makeLocalStorage())
  localStorage.setItem('bento.locale', 'es')
})
