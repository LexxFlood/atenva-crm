import test from 'node:test';
import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
import jsQR from 'jsqr';
import {brandedQrDataUrl} from '../src/branded-qr.js';
import {allowedAvatarUrl,contactAvatarImage} from '../src/contact-avatar.js';

test('QR com logo Atenva preserva o conteúdo em tamanhos reais de conexão',async()=>{
  for(const text of ['Atenva QR de teste','2@'+('AbCdeFGhIjkLMnOpqRstUVwxYZ0123456789+/='.repeat(8))]){
    const data=await brandedQrDataUrl(text);
    const image=PNG.sync.read(Buffer.from(data.split(',')[1],'base64'));
    const result=jsQR(new Uint8ClampedArray(image.data),image.width,image.height);
    assert.equal(result?.data,text);
    const size=320,resized=new Uint8ClampedArray(size*size*4);
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const source=(Math.floor(y*image.height/size)*image.width+Math.floor(x*image.width/size))*4;
      resized.set(image.data.subarray(source,source+4),(y*size+x)*4);
    }
    assert.equal(jsQR(resized,size,size)?.data,text);
  }
});

test('proxy de fotos aceita apenas CDN autorizada e não consulta endereços internos',async()=>{
  for(const url of ['http://127.0.0.1/a','https://localhost/a','https://pps.whatsapp.net.evil.test/a','https://user:secret@pps.whatsapp.net/a','https://pps.whatsapp.net:8443/a'])assert.equal(allowedAvatarUrl(url),false);
  assert.equal(allowedAvatarUrl('https://pps.whatsapp.net/qa.jpg'),true);
  const originalFetch=globalThis.fetch;
  const oldUrl=process.env.EVOLUTION_API_URL;process.env.EVOLUTION_API_URL='';
  let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Não deve consultar URL interna')};
  try{assert.equal(await contactAvatarImage({id:9001,profile_picture_url:'http://127.0.0.1/secret'},1),null);assert.equal(calls,0);}
  finally{globalThis.fetch=originalFetch;if(oldUrl===undefined)delete process.env.EVOLUTION_API_URL;else process.env.EVOLUTION_API_URL=oldUrl;}
});

test('busca de foto da Evolution usa cache e limita concorrência',async()=>{
  const originalFetch=globalThis.fetch;
  const old={url:process.env.EVOLUTION_API_URL,key:process.env.EVOLUTION_API_KEY,secret:process.env.EVOLUTION_WEBHOOK_SECRET};
  Object.assign(process.env,{EVOLUTION_API_URL:'http://evolution.test',EVOLUTION_API_KEY:'qa-key',EVOLUTION_WEBHOOK_SECRET:'qa-secret'});
  let calls=0,active=0,maximum=0;
  const picture=new PNG({width:2,height:2});picture.data.fill(255);const bytes=PNG.sync.write(picture);
  globalThis.fetch=async input=>{
    calls++;active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,5));active--;
    if(String(input).startsWith('http://evolution.test'))return new Response(JSON.stringify({profilePictureUrl:'https://pps.whatsapp.net/qa.jpg'}),{headers:{'content-type':'application/json'}});
    return new Response(bytes,{headers:{'content-type':'image/png'}});
  };
  try{
    const contact={id:9002,phone:'+5511987654321'};
    const [first,second]=await Promise.all([contactAvatarImage(contact,1),contactAvatarImage(contact,1)]);
    assert.deepEqual(first.bytes,bytes);assert.equal(first,second);assert.equal(calls,2);
    await Promise.all(Array.from({length:8},(_,i)=>contactAvatarImage({id:9010+i,phone:'+5511987654321'},1)));
    assert.ok(maximum<=2);
  }finally{
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries({EVOLUTION_API_URL:old.url,EVOLUTION_API_KEY:old.key,EVOLUTION_WEBHOOK_SECRET:old.secret})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
