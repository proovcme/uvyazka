import type {RvtDocument} from './rvt-document.ts';

/** Readability of the catalogue and geometry conversion are independent. */
export function hasReadableDocument(document:RvtDocument|null):boolean {
 return !!document?.records.some(record=>!!record.graph?.objects.length);
}
export function documentErrorMessage(error:string):string {
 const version=/native record framing is unvalidated for Revit (\d{4})/.exec(error)?.[1];
 return version?`Чтение записей RVT ${version} текущим декодером не поддерживается.`:error;
}
export function rvtImportFailure(rawMessage:string,document:RvtDocument|null,conversion:any){
 const readable=hasReadableDocument(document);
 const framing=/native record framing is unvalidated for Revit (\d{4})/.exec(document?.error??'');
 const version=conversion?.diagnostics?.input?.revit_version??(framing?Number(framing[1]):null);
 const empty=conversion?.diagnostics?.exported?.building_elements===0||/no validated typed IFC elements/.test(rawMessage);
 let message:string;
 if(readable)message='RVT открыт частично: 3D-геометрия не получена. Прочитанные виды, листы и таблицы доступны в «Виды и таблицы». Симуляция недоступна.';
 else if(framing)message=`RVT ${framing[1]}: текущий декодер не поддерживает чтение записей этой версии. Каталог не прочитан, 3D не получена. Это не означает, что модель пустая. Для просмотра сейчас нужен IFC.`;
 else if(empty)message=`${version?'RVT '+version:'RVT'}: декодер прочитал служебную структуру, но не распознал строительные элементы. 3D не получена; это не означает, что модель пустая.`;
 else message='Не удалось прочитать геометрию RVT. Причина и диагностика сохранены в журнале.';
 return {kind:readable?'partial' as const:'error' as const,message,details:{raw_message:rawMessage,revit_version:version,document_error:document?.error,readable_document:readable,document_records:document?.records.length??0,conversion}};
}
