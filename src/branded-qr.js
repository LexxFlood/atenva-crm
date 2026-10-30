import QRCode from 'qrcode';
import {PNG} from 'pngjs';
import {readFileSync} from 'node:fs';

let logo;
function brandMark(){
  if(!logo)logo=PNG.sync.read(readFileSync(new URL('../public/assets/atenva-mark-green.png',import.meta.url)));
  return logo;
}

export async function brandedQrDataUrl(text){
  if(typeof text!=='string'||!text||text.length>4096)throw new Error('Conteúdo de QR inválido.');
  const png=PNG.sync.read(await QRCode.toBuffer(text,{errorCorrectionLevel:'H',margin:4,width:512,color:{dark:'#10251aff',light:'#ffffffff'}}));
  const mark=brandMark();
  const plate=Math.round(png.width*.14),left=Math.floor((png.width-plate)/2),top=Math.floor((png.height-plate)/2);
  const inset=5,size=plate-inset*2;
  for(let y=0;y<plate;y++)for(let x=0;x<plate;x++){
    const index=((top+y)*png.width+left+x)*4;png.data.fill(255,index,index+4);
  }
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const sx=Math.floor(x*mark.width/size),sy=Math.floor(y*mark.height/size),source=(sy*mark.width+sx)*4;
    const destination=((top+inset+y)*png.width+left+inset+x)*4,alpha=mark.data[source+3]/255;
    for(let c=0;c<3;c++)png.data[destination+c]=Math.round(mark.data[source+c]*alpha+255*(1-alpha));
    png.data[destination+3]=255;
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}
