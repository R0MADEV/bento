import { getAppLocale } from './i18n'

const esToEn: Record<string, string> = {
  'Acciones': 'Actions', 'Actualizar': 'Refresh', 'Añadir': 'Add', 'Abrir': 'Open', 'Aceptar': 'Accept',
  'Buscar': 'Search', 'Buscar…': 'Search…', 'Cancelar': 'Cancel', 'Cerrar': 'Close', 'Cargando…': 'Loading…',
  'Conectar': 'Connect', 'Conectando…': 'Connecting…', 'Copiar': 'Copy', 'Crear': 'Create', 'Desconectar': 'Disconnect',
  'Editar': 'Edit', 'Eliminar': 'Delete', 'Error': 'Error', 'Filtrar…': 'Filter…', 'Guardar': 'Save',
  'Limpiar': 'Clear', 'Más': 'More', 'Nueva': 'New', 'Nuevo': 'New', 'Parar': 'Stop', 'Recargar': 'Reload',
  'Reintentar': 'Retry', 'Restaurar': 'Restore', 'Seleccionar': 'Select', 'Sin resultados': 'No results', 'Volver': 'Back',
  'Configuración': 'Settings', 'Contraseña': 'Password', 'Usuario': 'User', 'Nombre': 'Name', 'Descripción': 'Description',
  'Estado': 'Status', 'Fecha': 'Date', 'Ruta': 'Path', 'Contenido': 'Content', 'Vista previa': 'Preview',
  'Bases de datos': 'Databases', 'Contenedores': 'Containers', 'Colecciones': 'Collections', 'Tablas': 'Tables',
  'Consultas': 'Queries', 'Ejecutar': 'Run', 'Ejecutando…': 'Running…', 'Conexión': 'Connection',
  'Sin conexión': 'Disconnected', 'Conectado': 'Connected', 'Sin contenedores': 'No containers',
  'Solicitudes': 'Requests', 'Respuesta': 'Response', 'Enviar': 'Send', 'Enviando…': 'Sending…',
  'Cabeceras': 'Headers', 'Cuerpo': 'Body', 'Parámetros': 'Parameters', 'Colección': 'Collection',
  'Incidencias': 'Issues', 'Proyecto': 'Project', 'Asignado': 'Assignee', 'Prioridad': 'Priority',
  'Transición': 'Transition', 'Sin incidencias': 'No issues', 'Configurar Jira': 'Configure Jira',
  'Memoria': 'Memory', 'Recuerdos': 'Memories', 'Fuentes': 'Sources', 'Importar': 'Import', 'Regenerar': 'Regenerate',
  'Sin recuerdos': 'No memories', 'Resumen': 'Summary', 'Etiquetas': 'Tags', 'Archivos': 'Files',
  'Notas': 'Notes', 'Nueva nota': 'New note', 'Sin notas': 'No notes', 'Renombrar': 'Rename',
  'Scripts': 'Scripts', 'Sin scripts': 'No scripts', 'Directorio': 'Directory', 'Comando': 'Command',
  'Terminal': 'Terminal', 'Tema': 'Theme', 'Perfil': 'Profile', 'Buscar en terminal': 'Search terminal',
  'Canales': 'Channels', 'Favoritos': 'Favorites', 'Todos': 'All', 'País': 'Country', 'Idioma': 'Language',
  'Reproducir': 'Play', 'Pausar': 'Pause', 'Pantalla completa': 'Fullscreen',
  'Vault bloqueado': 'Vault locked', 'Desbloquear': 'Unlock', 'Bloquear': 'Lock', 'Servicio': 'Service',
  'URL': 'URL', 'Notas adicionales': 'Additional notes', 'Nueva entrada': 'New entry',
  'Atrás': 'Back', 'Adelante': 'Forward', 'Inicio': 'Home', 'Marcadores': 'Bookmarks', 'Historial': 'History',
  'Nueva pestaña': 'New tab', 'Dirección web': 'Web address', 'Ir': 'Go',
}

const uiTags = new Set(['BUTTON', 'LABEL', 'OPTION', 'SUMMARY', 'TH', 'LEGEND'])
const uiClass = /(title|header|toolbar|actions?|empty|hint|status|message|label|tab|badge|button|btn)(?:\s|$)/i

function translate(value: string): string {
  const trimmed = value.trim()
  const translated = esToEn[trimmed]
  return translated ? value.replace(trimmed, translated) : value
}

function translateElement(element: Element): void {
  for (const attribute of ['title', 'placeholder', 'aria-label']) {
    const value = element.getAttribute(attribute)
    if (value) {
      const translated = translate(value)
      if (translated !== value) element.setAttribute(attribute, translated)
    }
  }
  for (const node of element.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue
    const html = element as HTMLElement
    if (uiTags.has(element.tagName) || uiClass.test(html.className || '')) node.textContent = translate(node.textContent)
  }
}

export function localizePanel(root: HTMLElement): () => void {
  if (getAppLocale() !== 'en') return () => {}
  const apply = (node: Node): void => {
    if (node instanceof Element) {
      translateElement(node)
      node.querySelectorAll('*').forEach(translateElement)
    }
  }
  apply(root)
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') translateElement(record.target as Element)
      record.addedNodes.forEach(apply)
    }
  })
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'placeholder', 'aria-label'] })
  return () => observer.disconnect()
}
