# Quiz Email Service - Google Apps Script

## Configuración

1. Ir a **script.google.com**
2. Crear nuevo proyecto
3. Copiar el contenido de `EmailService.gs` al editor
4. Ejecutar `testSingle()` una vez para autorizar permisos

## Funciones principales

| Función | Uso |
|---------|-----|
| `processUserResponse(email, problem, choice)` | Envía ambos emails |
| `doPost(e)` | Web App endpoint |
| `onFormSubmit(e)` | Trigger de Google Forms |

## Emails enviados

- **Results** → errolw@xpertus.com, qrxpertus@gmail.com
- **Explanation** → Responder (email del usuario)

## Problemas soportados

- **The Lost Climber** (Search) - Opciones A, B
- **Hiring a Project Manager** (Hire) - Opciones A, B
- **The Machine Failure** (Decide) - Opciones A, B
- **The Blood Test** (Doctor) - Opciones A, B, C

## Despliegue como Web App

1. Desplegar > Nueva implementación > Aplicación web
2. Ejecutar como: Yo
3. Acceso: Cualquiera
4. Copiar URL generada

## Test

Ejecutar `testAll()` para probar los 3 escenarios de cada problema.
