/** Local action declarations; never accept this object from a portable media preset. */
export type LocalActionDraft={name:string;args:string[];uploads:boolean;timeoutSeconds:number;mediaTypes:('video'|'audio')[];adapter?:'executable'|'sharex'};
export function shareXAction(taskName:string):LocalActionDraft {
  const task=taskName.trim();
  if(!task||task.length>120||/[\0\r\n{}]/.test(task))throw new Error('ShareX task name must be 1–120 characters without braces or line breaks.');
  return {name:`ShareX: ${task}`.slice(0,80),adapter:'sharex',args:['{file}','-task',task],uploads:true,timeoutSeconds:60,mediaTypes:['video','audio']};
}
