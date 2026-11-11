export interface TechnicalReply {success:boolean;text:string}
/** Only consultation failure before a worker response is attempted can become a failure reply. */
export async function deliverTechnicalReply(consult:()=>Promise<TechnicalReply>, respond:(reply:TechnicalReply)=>Promise<unknown>, failed:(error:unknown)=>void):Promise<void>{
 let reply:TechnicalReply
 try{reply=await consult()}catch(error){
  try{failed(error)}catch{/* Logging failure must not prevent the single truthful worker response. */}
  reply={success:false,text:'TECHNICAL_CONSULTATION_FAILED: The host could not obtain a technical answer. The question remains unresolved. Return blocked with the outstanding question; do not claim an answer or automatically repeat the failed consultation.'}
 }
 // A partial/unknown worker write must propagate, never trigger a second response.
 await respond(reply)
}
