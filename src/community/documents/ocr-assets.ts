import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';

const require=createRequire(import.meta.url);
export const OCR_ASSETS={
  eng:{package:'@tesseract.js-data/eng',version:'1.0.0',compressed:'45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',raw:'5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747',bytes:5199098},
  deu:{package:'@tesseract.js-data/deu',version:'1.0.0',compressed:'306c4280d0cbed46fbff727486bd43b92730181bae80f56941a091f363bdf28b',raw:'a1b72cc25753eac167edfef5af4448a8dc34973503a2265c34c84520f896eb03',bytes:2070514},
} as const;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function regular(path:string,max:number):Buffer{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>max)throw new Error('Untrusted packaged OCR resource');return readFileSync(path);}

/** Offline language assets ship through pinned npm packages, not a personal path. */
export function packagedOcrDirectory():string{
  const destination=join(tmpdir(),'matching-community-ocr-v1-5dc5d8d6-a1b72cc2');
  if(existsSync(destination)&&(!lstatSync(destination).isDirectory()||lstatSync(destination).isSymbolicLink()))throw new Error('OCR cache path is unsafe');
  mkdirSync(destination,{recursive:true,mode:0o700});
  for(const[language,asset]of Object.entries(OCR_ASSETS)){
    const output=join(destination,language+'.traineddata');
    if(existsSync(output)){
      const raw=regular(output,32*1024*1024);if(raw.length!==asset.bytes||sha(raw)!==asset.raw)throw new Error('Packaged OCR cache integrity check failed');continue;
    }
    const modulePath=require.resolve(asset.package+'/package.json');
    const metadata=JSON.parse(regular(modulePath,65536).toString('utf8')) as {name:string;version:string};
    if(metadata.name!==asset.package||metadata.version!==asset.version)throw new Error('Unqualified OCR language package version');
    const compressed=regular(join(dirname(modulePath),'4.0.0_best_int',language+'.traineddata.gz'),16*1024*1024);
    if(sha(compressed)!==asset.compressed)throw new Error('Packaged OCR language hash does not match the qualified artifact');
    const raw=gunzipSync(compressed,{maxOutputLength:32*1024*1024});
    if(raw.length!==asset.bytes||sha(raw)!==asset.raw)throw new Error('Unpacked OCR language resource is invalid');
    const pending=output+'.'+randomUUID()+'.pending';
    try{writeFileSync(pending,raw,{flag:'wx',mode:0o600});renameSync(pending,output);}finally{if(existsSync(pending))unlinkSync(pending);}
  }
  return destination;
}
