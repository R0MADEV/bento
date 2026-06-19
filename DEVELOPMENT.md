# Guía de Desarrollo — Bento

Seguimos el CLAUDE.md del proyecto:

## Reglas

1. **Mínimo código**: YAGNI primero. ¿Necesita esto existir? → Usa stdlib/dependencia/feature nativa.
2. **No recortar**: Validación, errores, seguridad, accesibilidad son intocables.
3. **TDD**: Red → Green → Refactor. Primero el test, luego el código.
4. **Guard clauses**: Early return, no ifs anidados.
5. **Condicionales**: Si tiene `&&`, `||`, `.some()`, `.includes()` con lógica → extraer a `const` descriptiva.
6. **Git**: `feat:`, `fix:` (pretérito). Branch: `feat/...`, `fix/...`.
7. **Code reading**: Usa **lexis** MCP (`search_code`, `read_file` con offset/limit), no `grep`/`cat` enteros.

## Próxima fase: Fase 2 (Layout con dos paneles)

### Checklist

- [ ] Integrar Dockview (deps ya en package.json)
- [ ] Dockview root en main.ts
- [ ] Dos paneles tile: TV (izquierda) y Terminal (derecha)
- [ ] Redimensionables arrastrando borde
- [ ] Test: panel resize funciona

### Archivos a tocar

- `src/main.ts` — bootstrap Dockview
- `src/workspace/types.ts` — tipos PanelConfig, WindowConfig
- `src/workspace/manager.ts` — load/save state (minimal)
- `src/styles.css` — layout base

## Running

```bash
# En host
cd bento
docker-compose run --rm bento

# Dentro del contenedor
npm run tauri:dev
```

Browser: `http://localhost:5173`

## Testing

Aún no. En Fase 2, decidimos si xunit/vitest o E2E (Cypress/Playwright).
