import React from 'react';
import {useOptionalLanguage} from './locale';

/** Translate presentation literals only; original records and protocol values stay intact. */
export function useLegacyText(english:Readonly<Record<string,string>>):(german:string,values?:Record<string,string|number>)=>string {
 const context=useOptionalLanguage();
 // Standalone legacy embeddings retain their original language. The actual
 // application always supplies LanguageProvider, whose default is English.
 const language=context?.language??'de';
 return React.useCallback((german:string,values:Record<string,string|number>={})=>{
  const template=language==='de'?german:english[german]??german;
  return template.replace(/\{([a-zA-Z]\w*)\}/g,(match,key:string)=>Object.prototype.hasOwnProperty.call(values,key)?String(values[key]):match);
 },[language,english]);
}
