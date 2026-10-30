/* Uninstalled F05C native-file handoff. Creates no controls/listeners or remote
 * previews. The later controller supplies FileList from its existing input/drop
 * composition and renders into existing preview/remove elements. */
(function(root){
  function create({transport,urls=root.URL,id=()=>root.crypto.randomUUID()}={}) {
    if(!transport||typeof transport.select!=='function'||typeof transport.remove!=='function')throw Error('Upload unavailable');
    const rows=new Map(),files=new WeakMap();let closed=false;
    const alive=()=>{if(closed)throw Error('Upload unavailable');};
    const revoke=row=>{if(row.preview){urls.revokeObjectURL(row.preview);row.preview=null;}};
    return {
      restore(selections){
        alive();if(rows.size)throw Error('Selection unavailable');
        for(const selection of selections)rows.set(selection.key,{key:selection.key,preview:null});
      },
      select(list) {
        alive();const selected=Array.from(list);
        if(selected.some(file=>!(file instanceof root.File)))throw Error('Local files required');
        return selected.map(file=>{
          if(files.has(file))return files.get(file);
          const key=id();
          if(rows.has(key))throw Error('Selection identity collision');
          // TIFF stays uploadable but has no promised browser thumbnail. Never
          // fetch a provider UUID or an arbitrary URL to construct this preview.
          const preview=file.size>0&&file.size<=20*1024*1024&&['image/jpeg','image/png'].includes(file.type)?urls.createObjectURL(file):null;
          const row={key,preview,file};rows.set(key,row);
          let completion;
          try {completion=Promise.resolve(transport.select(key,file));}
          catch(error){revoke(row);throw error;}
          // Invalid selections still reach the transport's blocking lifecycle.
          // Observing failure here prevents an unhandled rejection; the caller
          // receives the original promise and must render its existing state.
          completion.catch(()=>{});
          const selection=Object.freeze({key,preview_url:preview,completion});files.set(file,selection);
          return selection;
        });
      },
      async remove(key) {
        alive();const row=rows.get(key);if(!row)throw Error('Selection unavailable');
        const result=await transport.remove(key);
        if(result.state==='removed'){revoke(row);if(row.file)files.delete(row.file);}
        return result; // transport retains terminal history
      },
      dispose() {if(closed)return;closed=true;for(const row of rows.values())revoke(row);rows.clear();transport.dispose();},
    };
  }
  root.BFLNativeFiles={create};
})(typeof window==='undefined'?globalThis:window);
