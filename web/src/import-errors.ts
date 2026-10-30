export class SourceAlreadyPresent extends Error {readonly code='SOURCE_ALREADY_PRESENT';constructor(){super('Этот исходный файл уже есть в сцене. Повторное добавление пропущено.');}}
export function importErrorMessage(message:string):string{
 if(/Unsupported (NWD )?container|header\/footer|Directory pointer|Directory header/i.test(message))return 'Структура файла повреждена или пока не поддерживается читателем. Остальные файлы очереди могут быть открыты.';
 if(/budget|exceeds|memory|allocation|out of bounds/i.test(message))return 'Не удалось обработать все данные файла. Подробная причина сохранена в журнале.';
 if(/No supported|No usable|пригодная геометрия не получена|unsupported_scene/i.test(message))return 'В файле не удалось получить пригодную геометрию. Доступные данные и ограничения — в журнале.';
 return message;
}
