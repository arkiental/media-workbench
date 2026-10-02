export type HeaderCaption = {text:string;size:number;padding:number};
export function captionLayout(caption:HeaderCaption|undefined,width:number) {
  if(!caption?.text.trim())return {text:'',height:0,size:0,padding:0,lineHeight:0};
  const size=Math.min(caption.size,Math.max(8,Math.floor(width/2)));
  const padding=Math.min(caption.padding,Math.max(0,Math.floor((width-size)/2)));
  const columns=Math.max(1,Math.floor((width-padding*2)/(size*.7)));
  const lines:string[]=[];
  for(const paragraph of caption.text.replace(/\r/g,'').split('\n')) {
    let line='';
    for(const word of paragraph.trim().split(/\s+/)) {
      if(line&&[...line,...word].length+1>columns){lines.push(line);line='';}
      const characters=[...word];
      while(characters.length>columns){if(line){lines.push(line);line='';}lines.push(characters.splice(0,columns).join(''));}
      line+=(line?' ':'')+characters.join('');
    }
    lines.push(line);
  }
  const lineHeight=Math.ceil(size*1.25);
  return {text:lines.join('\n'),height:Math.ceil((lines.length*lineHeight+padding*2)/2)*2,size,padding,lineHeight};
}
